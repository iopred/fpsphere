use crate::protocol::{CommitTarget, WorldSnapshot};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio::time::{interval, Duration, MissedTickBehavior};

const SNAPSHOT_TICK_INTERVAL: Duration = Duration::from_micros(16_666);
const DEFAULT_AVATAR_ID: &str = "duck";

fn normalize_avatar_id_option(raw_avatar_id: Option<&str>) -> Option<String> {
    let normalized = raw_avatar_id?.trim();
    if normalized.is_empty() {
        return None;
    }

    match normalized {
        "duck" => Some("duck".to_string()),
        "human" => Some("human".to_string()),
        _ => Some(DEFAULT_AVATAR_ID.to_string()),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlayerInputEnqueueResult {
    Queued,
    DroppedStaleOrDuplicate,
    PlayerMissing,
}

#[derive(Debug, Clone)]
struct PlayerInputCommand {
    client_tick: u64,
    position_3d: [f32; 3],
    yaw: f32,
    pitch: f32,
    avatar_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiplayerPlayerState {
    pub player_id: String,
    pub user_id: String,
    pub world_id: String,
    pub position_3d: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub avatar_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiplayerPlayerSnapshot {
    pub player_id: String,
    pub position_3d: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
    pub avatar_id: String,
    pub last_processed_input_tick: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMultiplayerMessage {
    Hello {
        user_id: Option<String>,
        world_id: Option<String>,
    },
    PlayerUpdate {
        position_3d: [f32; 3],
        yaw: f32,
        pitch: f32,
        client_tick: u64,
        #[serde(default)]
        avatar_id: Option<String>,
    },
    Ping,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMultiplayerMessage {
    Welcome {
        player_id: String,
        user_id: String,
        world_id: String,
    },
    StateSnapshot {
        world_id: String,
        server_tick: u64,
        players: Vec<MultiplayerPlayerSnapshot>,
    },
    WorldCommitApplied {
        world_id: String,
        commit_id: String,
        saved_to: CommitTarget,
        user_id: Option<String>,
        world: WorldSnapshot,
    },
    Error {
        message: String,
    },
    Pong,
}

#[derive(Default)]
struct AuthoritativePlayerStore {
    by_world: HashMap<String, HashMap<String, MultiplayerPlayerState>>,
    world_by_player_id: HashMap<String, String>,
    pending_inputs_by_player: HashMap<String, BTreeMap<u64, PlayerInputCommand>>,
    last_processed_input_seq_by_player: HashMap<String, u64>,
}

impl AuthoritativePlayerStore {
    fn insert_player(&mut self, player: MultiplayerPlayerState) {
        let world_id = player.world_id.clone();
        let player_id = player.player_id.clone();

        self.by_world
            .entry(world_id.clone())
            .or_default()
            .insert(player_id.clone(), player);
        self.world_by_player_id.insert(player_id, world_id);
    }

    fn set_player_identity(&mut self, player_id: &str, user_id: String) {
        if let Some(player) = self.get_player_mut(player_id) {
            player.user_id = user_id;
        }
    }

    fn update_player_pose(
        &mut self,
        player_id: &str,
        client_tick: u64,
        position_3d: [f32; 3],
        yaw: f32,
        pitch: f32,
        avatar_id: Option<String>,
    ) -> PlayerInputEnqueueResult {
        if !self.world_by_player_id.contains_key(player_id) {
            return PlayerInputEnqueueResult::PlayerMissing;
        }

        if self
            .last_processed_input_seq_by_player
            .get(player_id)
            .is_some_and(|value| client_tick <= *value)
        {
            return PlayerInputEnqueueResult::DroppedStaleOrDuplicate;
        }

        let pending = self
            .pending_inputs_by_player
            .entry(player_id.to_string())
            .or_default();
        if pending.contains_key(&client_tick) {
            return PlayerInputEnqueueResult::DroppedStaleOrDuplicate;
        }

        pending.insert(
            client_tick,
            PlayerInputCommand {
                client_tick,
                position_3d,
                yaw,
                pitch,
                avatar_id: normalize_avatar_id_option(avatar_id.as_deref()),
            },
        );
        PlayerInputEnqueueResult::Queued
    }

    fn process_queued_inputs(&mut self) {
        let player_ids = self
            .pending_inputs_by_player
            .keys()
            .cloned()
            .collect::<Vec<_>>();

        for player_id in player_ids {
            let Some(queue) = self.pending_inputs_by_player.get_mut(&player_id) else {
                continue;
            };

            if queue.is_empty() {
                continue;
            }

            let commands = queue.values().cloned().collect::<Vec<_>>();
            queue.clear();

            let mut next_processed = self
                .last_processed_input_seq_by_player
                .get(&player_id)
                .copied();

            if let Some(player) = self.get_player_mut(&player_id) {
                for command in commands {
                    if next_processed.is_some_and(|value| command.client_tick <= value) {
                        continue;
                    }

                    player.position_3d = command.position_3d;
                    player.yaw = command.yaw;
                    player.pitch = command.pitch;
                    if let Some(avatar_id) = command.avatar_id {
                        player.avatar_id = avatar_id;
                    }
                    next_processed = Some(command.client_tick);
                }
            }

            if let Some(last_value) = next_processed {
                self.last_processed_input_seq_by_player
                    .insert(player_id.clone(), last_value);
            }
        }

        self.pending_inputs_by_player
            .retain(|_, queue| !queue.is_empty());
    }

    fn drop_player_runtime_state(&mut self, player_id: &str) {
        self.pending_inputs_by_player.remove(player_id);
        self.last_processed_input_seq_by_player.remove(player_id);
    }

    fn player_world_id(&self, player_id: &str) -> Option<String> {
        self.world_by_player_id.get(player_id).cloned()
    }

    fn clear_world_if_empty(&mut self, world_id: &str) {
        if self
            .by_world
            .get(world_id)
            .is_some_and(|players| players.is_empty())
        {
            self.by_world.remove(world_id);
        };
    }

    fn remove_player(&mut self, player_id: &str) {
        let Some(world_id) = self.player_world_id(player_id) else {
            return;
        };

        self.world_by_player_id.remove(player_id);

        let Some(world_players) = self.by_world.get_mut(&world_id) else {
            self.drop_player_runtime_state(player_id);
            return;
        };

        world_players.remove(player_id);
        self.clear_world_if_empty(&world_id);
        self.drop_player_runtime_state(player_id);
    }

    fn world_ids(&self) -> Vec<String> {
        let mut ids = self.by_world.keys().cloned().collect::<Vec<_>>();
        ids.sort();
        ids
    }

    fn snapshots_for_world(&self, world_id: &str) -> Vec<MultiplayerPlayerSnapshot> {
        let Some(players) = self.by_world.get(world_id) else {
            return Vec::new();
        };

        let mut snapshots = players
            .values()
            .map(|item| MultiplayerPlayerSnapshot {
                player_id: item.player_id.clone(),
                position_3d: item.position_3d,
                yaw: item.yaw,
                pitch: item.pitch,
                avatar_id: item.avatar_id.clone(),
                last_processed_input_tick: self
                    .last_processed_input_seq_by_player
                    .get(&item.player_id)
                    .copied()
                    .unwrap_or(0),
            })
            .collect::<Vec<_>>();

        snapshots.sort_by(|a, b| a.player_id.cmp(&b.player_id));
        snapshots
    }

    fn get_player_mut(&mut self, player_id: &str) -> Option<&mut MultiplayerPlayerState> {
        let world_id = self.world_by_player_id.get(player_id)?.clone();
        self.by_world.get_mut(&world_id)?.get_mut(player_id)
    }
}

#[derive(Clone)]
pub struct MultiplayerHub {
    players: Arc<RwLock<AuthoritativePlayerStore>>,
    player_seq: Arc<AtomicU64>,
    server_tick: Arc<AtomicU64>,
    tx: broadcast::Sender<ServerMultiplayerMessage>,
}

impl MultiplayerHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        let hub = Self {
            players: Arc::new(RwLock::new(AuthoritativePlayerStore::default())),
            player_seq: Arc::new(AtomicU64::new(0)),
            server_tick: Arc::new(AtomicU64::new(0)),
            tx,
        };
        hub.start_snapshot_loop();
        hub
    }

    #[cfg(test)]
    fn new_without_snapshot_loop() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self {
            players: Arc::new(RwLock::new(AuthoritativePlayerStore::default())),
            player_seq: Arc::new(AtomicU64::new(0)),
            server_tick: Arc::new(AtomicU64::new(0)),
            tx,
        }
    }

    fn start_snapshot_loop(&self) {
        let Ok(runtime_handle) = tokio::runtime::Handle::try_current() else {
            return;
        };

        let hub = self.clone();
        runtime_handle.spawn(async move {
            hub.run_snapshot_loop().await;
        });
    }

    async fn run_snapshot_loop(self) {
        let mut ticker = interval(SNAPSHOT_TICK_INTERVAL);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);

        loop {
            ticker.tick().await;
            self.process_queued_inputs().await;
            self.broadcast_all_world_snapshots().await;
        }
    }

    async fn process_queued_inputs(&self) {
        self.players.write().await.process_queued_inputs();
    }

    async fn broadcast_all_world_snapshots(&self) {
        let world_ids = {
            let store = self.players.read().await;
            store.world_ids()
        };

        for world_id in world_ids {
            self.broadcast_world_snapshot(world_id.as_str()).await;
        }
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ServerMultiplayerMessage> {
        self.tx.subscribe()
    }

    pub async fn add_player(&self, user_id: String, world_id: String) -> MultiplayerPlayerState {
        let player_id = format!(
            "player-{}",
            self.player_seq.fetch_add(1, Ordering::SeqCst) + 1
        );
        let player_state = MultiplayerPlayerState {
            player_id: player_id.clone(),
            user_id,
            world_id: world_id.clone(),
            position_3d: [0.0, -2.5, 16.0],
            yaw: 0.0,
            pitch: 0.0,
            avatar_id: DEFAULT_AVATAR_ID.to_string(),
        };

        self.players
            .write()
            .await
            .insert_player(player_state.clone());

        player_state
    }

    pub async fn set_player_identity(&self, player_id: &str, user_id: Option<String>) {
        let Some(next_user_id) = user_id else {
            return;
        };

        if next_user_id.trim().is_empty() {
            return;
        }

        self.players
            .write()
            .await
            .set_player_identity(player_id, next_user_id);
    }

    pub async fn update_player(
        &self,
        player_id: &str,
        position_3d: [f32; 3],
        yaw: f32,
        pitch: f32,
        client_tick: u64,
        avatar_id: Option<String>,
    ) -> PlayerInputEnqueueResult {
        self.players.write().await.update_player_pose(
            player_id,
            client_tick,
            position_3d,
            yaw,
            pitch,
            avatar_id,
        )
    }

    pub async fn remove_player(&self, player_id: &str) {
        self.players.write().await.remove_player(player_id);
    }

    pub async fn broadcast_world_snapshot(&self, world_id: &str) {
        let players = {
            let store = self.players.read().await;
            store.snapshots_for_world(world_id)
        };
        let server_tick = self.server_tick.fetch_add(1, Ordering::SeqCst) + 1;

        let _ = self.tx.send(ServerMultiplayerMessage::StateSnapshot {
            world_id: world_id.to_string(),
            server_tick,
            players,
        });
    }

    pub fn broadcast_world_commit(
        &self,
        world_id: String,
        commit_id: String,
        saved_to: CommitTarget,
        user_id: Option<String>,
        world: WorldSnapshot,
    ) {
        let _ = self.tx.send(ServerMultiplayerMessage::WorldCommitApplied {
            world_id,
            commit_id,
            saved_to,
            user_id,
            world,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{MultiplayerHub, PlayerInputEnqueueResult, ServerMultiplayerMessage};
    use crate::protocol::{example_world_snapshot, CommitTarget};
    use std::collections::BTreeMap;
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn add_update_and_remove_player() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let player = hub
            .add_player("user-a".to_string(), "world-main".to_string())
            .await;

        let updated = hub
            .update_player(&player.player_id, [2.0, 3.0, 4.0], 1.0, 0.5, 7, None)
            .await;
        assert!(matches!(updated, PlayerInputEnqueueResult::Queued));

        hub.remove_player(&player.player_id).await;
    }

    #[tokio::test]
    async fn queued_input_drops_stale_and_duplicate_sequences() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let player = hub
            .add_player("user-a".to_string(), "world-main".to_string())
            .await;

        let first = hub
            .update_player(&player.player_id, [1.0, 2.0, 3.0], 0.1, 0.2, 1, None)
            .await;
        assert!(matches!(first, PlayerInputEnqueueResult::Queued));

        // Duplicate queued sequence is dropped.
        let duplicate_pending = hub
            .update_player(&player.player_id, [5.0, 6.0, 7.0], 0.6, 0.7, 1, None)
            .await;
        assert!(matches!(
            duplicate_pending,
            PlayerInputEnqueueResult::DroppedStaleOrDuplicate
        ));

        hub.process_queued_inputs().await;

        // Already-processed sequence is dropped as stale.
        let stale = hub
            .update_player(&player.player_id, [8.0, 9.0, 10.0], 0.8, 0.9, 1, None)
            .await;
        assert!(matches!(
            stale,
            PlayerInputEnqueueResult::DroppedStaleOrDuplicate
        ));

        let next = hub
            .update_player(&player.player_id, [11.0, 12.0, 13.0], 1.1, 1.2, 2, None)
            .await;
        assert!(matches!(next, PlayerInputEnqueueResult::Queued));

        let mut rx = hub.subscribe();
        hub.process_queued_inputs().await;
        hub.broadcast_world_snapshot("world-main").await;

        let result = timeout(Duration::from_millis(200), async {
            loop {
                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id,
                        server_tick,
                        players,
                    } => {
                        if world_id != "world-main" {
                            continue;
                        }

                        if let Some(player_snapshot) = players
                            .iter()
                            .find(|item| item.player_id == player.player_id)
                        {
                            assert!(server_tick > 0);
                            assert_eq!(player_snapshot.position_3d, [11.0, 12.0, 13.0]);
                            assert!((player_snapshot.yaw - 1.1).abs() < f32::EPSILON);
                            assert!((player_snapshot.pitch - 1.2).abs() < f32::EPSILON);
                            assert_eq!(player_snapshot.last_processed_input_tick, 2);
                            return;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "expected state snapshot with processed queued input"
        );
    }

    #[tokio::test]
    async fn player_avatar_id_is_applied_and_normalized() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let mut rx = hub.subscribe();
        let player = hub
            .add_player("user-avatar".to_string(), "world-main".to_string())
            .await;

        let human_update = hub
            .update_player(
                &player.player_id,
                [1.0, 0.0, 0.0],
                0.0,
                0.0,
                1,
                Some("human".to_string()),
            )
            .await;
        assert!(matches!(human_update, PlayerInputEnqueueResult::Queued));

        hub.process_queued_inputs().await;
        hub.broadcast_world_snapshot("world-main").await;

        let first_result = timeout(Duration::from_millis(200), async {
            loop {
                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } => {
                        if world_id != "world-main" {
                            continue;
                        }

                        if let Some(player_snapshot) = players
                            .iter()
                            .find(|item| item.player_id == player.player_id)
                        {
                            assert_eq!(player_snapshot.avatar_id, "human");
                            return;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;
        assert!(
            first_result.is_ok(),
            "expected avatar snapshot within timeout"
        );

        let invalid_update = hub
            .update_player(
                &player.player_id,
                [2.0, 0.0, 0.0],
                0.0,
                0.0,
                2,
                Some("robot".to_string()),
            )
            .await;
        assert!(matches!(invalid_update, PlayerInputEnqueueResult::Queued));

        hub.process_queued_inputs().await;
        hub.broadcast_world_snapshot("world-main").await;

        let second_result = timeout(Duration::from_millis(200), async {
            loop {
                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } => {
                        if world_id != "world-main" {
                            continue;
                        }

                        if let Some(player_snapshot) = players
                            .iter()
                            .find(|item| item.player_id == player.player_id)
                        {
                            assert_eq!(player_snapshot.avatar_id, "duck");
                            return;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;
        assert!(
            second_result.is_ok(),
            "expected normalized avatar snapshot within timeout"
        );
    }

    #[tokio::test]
    async fn queued_input_applies_in_tick_order_not_arrival_order() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let mut rx = hub.subscribe();
        let player = hub
            .add_player("user-a".to_string(), "world-main".to_string())
            .await;

        // Intentionally enqueue out of order.
        let third = hub
            .update_player(&player.player_id, [30.0, 0.0, 0.0], 0.3, 0.3, 3, None)
            .await;
        let first = hub
            .update_player(&player.player_id, [10.0, 0.0, 0.0], 0.1, 0.1, 1, None)
            .await;
        let second = hub
            .update_player(&player.player_id, [20.0, 0.0, 0.0], 0.2, 0.2, 2, None)
            .await;

        assert!(matches!(first, PlayerInputEnqueueResult::Queued));
        assert!(matches!(second, PlayerInputEnqueueResult::Queued));
        assert!(matches!(third, PlayerInputEnqueueResult::Queued));

        hub.process_queued_inputs().await;
        hub.broadcast_world_snapshot("world-main").await;

        let result = timeout(Duration::from_millis(200), async {
            loop {
                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } => {
                        if world_id != "world-main" {
                            continue;
                        }

                        if let Some(player_snapshot) = players
                            .iter()
                            .find(|item| item.player_id == player.player_id)
                        {
                            assert_eq!(player_snapshot.position_3d, [30.0, 0.0, 0.0]);
                            assert_eq!(player_snapshot.last_processed_input_tick, 3);
                            return;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "expected ordered input processing snapshot within timeout"
        );
    }

    #[tokio::test]
    async fn snapshot_loop_emits_periodic_world_snapshot() {
        let hub = MultiplayerHub::new();
        let mut rx = hub.subscribe();
        let player = hub
            .add_player("user-a".to_string(), "world-main".to_string())
            .await;

        let result = timeout(Duration::from_millis(250), async {
            loop {
                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } => {
                        if world_id == "world-main"
                            && players
                                .iter()
                                .any(|item| item.player_id == player.player_id)
                        {
                            return;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "expected periodic state snapshot within 250ms"
        );
    }

    #[tokio::test]
    async fn snapshots_are_scoped_by_world_store_key() {
        let hub = MultiplayerHub::new();
        let mut rx = hub.subscribe();

        let main_player = hub
            .add_player("user-a".to_string(), "world-main".to_string())
            .await;
        let other_player = hub
            .add_player("user-b".to_string(), "world-beta".to_string())
            .await;

        let result = timeout(Duration::from_millis(300), async {
            loop {
                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } => {
                        if world_id != "world-main" {
                            continue;
                        }

                        let contains_main = players
                            .iter()
                            .any(|item| item.player_id == main_player.player_id);
                        let contains_other = players
                            .iter()
                            .any(|item| item.player_id == other_player.player_id);
                        assert!(contains_main);
                        assert!(!contains_other);
                        return;
                    }
                    _ => continue,
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "expected scoped world snapshot within 300ms"
        );
    }

    #[tokio::test]
    async fn world_switch_via_remove_and_rejoin_does_not_leak_old_world_membership() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let mut rx = hub.subscribe();

        let original = hub
            .add_player("user-switch".to_string(), "world-main".to_string())
            .await;
        hub.remove_player(&original.player_id).await;

        let switched = hub
            .add_player("user-switch".to_string(), "world-beta".to_string())
            .await;

        hub.broadcast_world_snapshot("world-main").await;
        hub.broadcast_world_snapshot("world-beta").await;

        let result = timeout(Duration::from_millis(300), async {
            let mut saw_world_main = false;
            let mut saw_world_beta = false;

            loop {
                if saw_world_main && saw_world_beta {
                    return;
                }

                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } => {
                        if world_id == "world-main" {
                            assert!(
                                players
                                    .iter()
                                    .all(|item| item.player_id != original.player_id),
                                "removed player must not remain in prior world snapshot"
                            );
                            assert!(
                                players
                                    .iter()
                                    .all(|item| item.player_id != switched.player_id),
                                "new player id must not appear in unrelated world snapshot"
                            );
                            saw_world_main = true;
                            continue;
                        }

                        if world_id == "world-beta" {
                            assert!(
                                players
                                    .iter()
                                    .any(|item| item.player_id == switched.player_id),
                                "rejoined player must appear in new world snapshot"
                            );
                            assert!(
                                players
                                    .iter()
                                    .all(|item| item.player_id != original.player_id),
                                "old player id must not leak into new world snapshot"
                            );
                            saw_world_beta = true;
                        }
                    }
                    _ => continue,
                }
            }
        })
        .await;

        assert!(
            result.is_ok(),
            "expected clean world switch snapshot behavior within 300ms"
        );
    }

    #[tokio::test]
    async fn latency_simulation_keeps_authoritative_drift_bounded() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let mut rx = hub.subscribe();
        let player = hub
            .add_player("user-latency".to_string(), "world-main".to_string())
            .await;

        const TOTAL_INPUT_TICKS: u64 = 120;
        const SIMULATED_LATENCY_TICKS: u64 = 3;
        const DRAIN_TICKS: u64 = 8;

        let mut arrivals_by_tick: BTreeMap<u64, u64> = BTreeMap::new();
        for sequence in 1..=TOTAL_INPUT_TICKS {
            let arrival_tick = sequence + SIMULATED_LATENCY_TICKS;
            arrivals_by_tick.insert(arrival_tick, sequence);
        }

        let simulation_end_tick = TOTAL_INPUT_TICKS + DRAIN_TICKS;
        let mut max_sequence_drift: u64 = 0;

        for simulation_tick in 1..=simulation_end_tick {
            if let Some(sequence) = arrivals_by_tick.remove(&simulation_tick) {
                let enqueue = hub
                    .update_player(
                        &player.player_id,
                        [sequence as f32, 0.0, 0.0],
                        sequence as f32 * 0.01,
                        0.0,
                        sequence,
                        None,
                    )
                    .await;
                assert!(matches!(enqueue, PlayerInputEnqueueResult::Queued));
            }

            hub.process_queued_inputs().await;
            hub.broadcast_world_snapshot("world-main").await;

            let (world_id, players) = timeout(Duration::from_millis(200), async {
                loop {
                    let received = rx.recv().await.expect("state snapshot message");
                    if let ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } = received
                    {
                        break (world_id, players);
                    }
                }
            })
            .await
            .expect("expected state snapshot under latency simulation");

            assert_eq!(world_id, "world-main");
            let player_snapshot = players
                .iter()
                .find(|item| item.player_id == player.player_id)
                .expect("player should be present in world snapshot");

            let authoritative_sequence = player_snapshot.last_processed_input_tick;
            let authoritative_x = player_snapshot.position_3d[0];
            let expected_x = authoritative_sequence as f32;
            assert!(
                (authoritative_x - expected_x).abs() <= f32::EPSILON,
                "authoritative position must match processed sequence-derived input"
            );

            let client_latest_sequence = simulation_tick.min(TOTAL_INPUT_TICKS);
            let sequence_drift = client_latest_sequence.saturating_sub(authoritative_sequence);
            max_sequence_drift = max_sequence_drift.max(sequence_drift);
        }

        assert!(
            max_sequence_drift <= SIMULATED_LATENCY_TICKS + 1,
            "expected sequence drift <= {} under normal latency simulation, observed {}",
            SIMULATED_LATENCY_TICKS + 1,
            max_sequence_drift
        );
    }

    #[tokio::test]
    async fn world_commit_broadcast_emits_message() {
        let hub = MultiplayerHub::new();
        let mut rx = hub.subscribe();
        let world = example_world_snapshot();

        hub.broadcast_world_commit(
            world.world_id.clone(),
            "master-1".to_string(),
            CommitTarget::Master,
            None,
            world.clone(),
        );

        let received = rx.recv().await.expect("commit broadcast message");
        match received {
            ServerMultiplayerMessage::WorldCommitApplied {
                world_id,
                commit_id,
                saved_to,
                world: payload_world,
                ..
            } => {
                assert_eq!(world_id, world.world_id);
                assert_eq!(commit_id, "master-1");
                assert!(matches!(saved_to, CommitTarget::Master));
                assert_eq!(payload_world.tick, world.tick);
            }
            _ => panic!("unexpected message type"),
        }
    }
}
