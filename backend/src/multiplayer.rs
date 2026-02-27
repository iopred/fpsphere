use crate::protocol::{CommitTarget, WorldSnapshot};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio::time::{interval, Duration, MissedTickBehavior};

const SNAPSHOT_TICK_INTERVAL: Duration = Duration::from_micros(16_666);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiplayerPlayerState {
    pub player_id: String,
    pub user_id: String,
    pub world_id: String,
    pub position_3d: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiplayerPlayerSnapshot {
    pub player_id: String,
    pub position_3d: [f32; 3],
    pub yaw: f32,
    pub pitch: f32,
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
        position_3d: [f32; 3],
        yaw: f32,
        pitch: f32,
    ) -> bool {
        let Some(player) = self.get_player_mut(player_id) else {
            return false;
        };

        player.position_3d = position_3d;
        player.yaw = yaw;
        player.pitch = pitch;
        true
    }

    fn remove_player(&mut self, player_id: &str) {
        let Some(world_id) = self.world_by_player_id.remove(player_id) else {
            return;
        };

        let Some(world_players) = self.by_world.get_mut(&world_id) else {
            return;
        };

        world_players.remove(player_id);
        if world_players.is_empty() {
            self.by_world.remove(&world_id);
        }
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
    tx: broadcast::Sender<ServerMultiplayerMessage>,
}

impl MultiplayerHub {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        let hub = Self {
            players: Arc::new(RwLock::new(AuthoritativePlayerStore::default())),
            player_seq: Arc::new(AtomicU64::new(0)),
            tx,
        };
        hub.start_snapshot_loop();
        hub
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
            self.broadcast_all_world_snapshots().await;
        }
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
        _client_tick: u64,
    ) -> bool {
        self.players
            .write()
            .await
            .update_player_pose(player_id, position_3d, yaw, pitch)
    }

    pub async fn remove_player(&self, player_id: &str) {
        self.players.write().await.remove_player(player_id);
    }

    pub async fn broadcast_world_snapshot(&self, world_id: &str) {
        let players = {
            let store = self.players.read().await;
            store.snapshots_for_world(world_id)
        };

        let _ = self.tx.send(ServerMultiplayerMessage::StateSnapshot {
            world_id: world_id.to_string(),
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
    use super::{MultiplayerHub, ServerMultiplayerMessage};
    use crate::protocol::{example_world_snapshot, CommitTarget};
    use tokio::time::{timeout, Duration};

    #[tokio::test]
    async fn add_update_and_remove_player() {
        let hub = MultiplayerHub::new();
        let player = hub
            .add_player("user-a".to_string(), "world-main".to_string())
            .await;

        let updated = hub
            .update_player(&player.player_id, [2.0, 3.0, 4.0], 1.0, 0.5, 7)
            .await;
        assert!(updated);

        hub.remove_player(&player.player_id).await;
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
                    ServerMultiplayerMessage::StateSnapshot { world_id, players } => {
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
                    ServerMultiplayerMessage::StateSnapshot { world_id, players } => {
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
