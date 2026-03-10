use crate::aoi::{
    covering_partition_keys, partition_key, select_ids_in_query, AoiDomain, AoiPolicy,
};
use crate::protocol::{CommitTarget, SphereEntity, WorldSnapshot};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tokio::time::{interval, Duration, MissedTickBehavior};

const SNAPSHOT_TICK_INTERVAL: Duration = Duration::from_micros(16_666);
const DEFAULT_AVATAR_ID: &str = "duck";
const WORLD_CONTEXT_KEY_SEPARATOR: &str = "\u{1f}";

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MultiplayerWorldContext {
    pub root_world_id: String,
    #[serde(default)]
    pub instance_path: Vec<String>,
}

pub(crate) fn normalize_world_context(
    world_id: &str,
    raw_world_context: Option<MultiplayerWorldContext>,
) -> Option<MultiplayerWorldContext> {
    let raw_context = raw_world_context?;
    let root_world_id = raw_context.root_world_id.trim();
    let normalized_root_world_id = if root_world_id.is_empty() {
        world_id.to_string()
    } else {
        root_world_id.to_string()
    };
    let instance_path = raw_context
        .instance_path
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if instance_path.is_empty() {
        return None;
    }

    Some(MultiplayerWorldContext {
        root_world_id: normalized_root_world_id,
        instance_path,
    })
}

fn world_context_key(world_context: Option<&MultiplayerWorldContext>) -> Option<String> {
    let context = world_context?;
    if context.instance_path.is_empty() {
        return None;
    }

    let mut value = String::new();
    value.push_str(context.root_world_id.as_str());
    for segment in &context.instance_path {
        value.push_str(WORLD_CONTEXT_KEY_SEPARATOR);
        value.push_str(segment.as_str());
    }

    Some(value)
}

pub(crate) fn master_world_commit_context_matches(
    session_world_context: Option<&MultiplayerWorldContext>,
    commit_world_context: Option<&MultiplayerWorldContext>,
) -> bool {
    world_context_key(session_world_context) == world_context_key(commit_world_context)
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
    world_context: Option<MultiplayerWorldContext>,
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
    pub world_context: Option<MultiplayerWorldContext>,
    pub visible_to_others: bool,
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
pub struct MultiplayerSnapshotDelta {
    pub world_id: String,
    pub server_tick: u64,
    pub baseline_server_tick: u64,
    pub upsert_players: Vec<MultiplayerPlayerSnapshot>,
    pub removed_player_ids: Vec<String>,
}

fn snapshots_match(left: &MultiplayerPlayerSnapshot, right: &MultiplayerPlayerSnapshot) -> bool {
    left.player_id == right.player_id
        && left.position_3d[0].to_bits() == right.position_3d[0].to_bits()
        && left.position_3d[1].to_bits() == right.position_3d[1].to_bits()
        && left.position_3d[2].to_bits() == right.position_3d[2].to_bits()
        && left.yaw.to_bits() == right.yaw.to_bits()
        && left.pitch.to_bits() == right.pitch.to_bits()
        && left.avatar_id == right.avatar_id
        && left.last_processed_input_tick == right.last_processed_input_tick
}

fn dimensions_match(left: &BTreeMap<String, f32>, right: &BTreeMap<String, f32>) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.iter()
        .zip(right.iter())
        .all(|((left_key, left_value), (right_key, right_value))| {
            left_key == right_key && left_value.to_bits() == right_value.to_bits()
        })
}

fn world_entities_match(left: &SphereEntity, right: &SphereEntity) -> bool {
    left.id == right.id
        && left.parent_id == right.parent_id
        && left.radius.to_bits() == right.radius.to_bits()
        && left.position_3d[0].to_bits() == right.position_3d[0].to_bits()
        && left.position_3d[1].to_bits() == right.position_3d[1].to_bits()
        && left.position_3d[2].to_bits() == right.position_3d[2].to_bits()
        && dimensions_match(&left.dimensions, &right.dimensions)
        && left.instance_world_id == right.instance_world_id
        && left.time_window.start_tick == right.time_window.start_tick
        && left.time_window.end_tick == right.time_window.end_tick
        && left.tags == right.tags
}

pub fn snapshot_players_by_id(
    players: &[MultiplayerPlayerSnapshot],
) -> HashMap<String, MultiplayerPlayerSnapshot> {
    let mut players_by_id = HashMap::with_capacity(players.len());
    for player in players {
        players_by_id.insert(player.player_id.clone(), player.clone());
    }
    players_by_id
}

pub fn world_entities_by_id(entities: &[SphereEntity]) -> HashMap<String, SphereEntity> {
    let mut entities_by_id = HashMap::with_capacity(entities.len());
    for entity in entities {
        entities_by_id.insert(entity.id.clone(), entity.clone());
    }
    entities_by_id
}

pub fn build_snapshot_delta(
    world_id: &str,
    server_tick: u64,
    players: &[MultiplayerPlayerSnapshot],
    baseline_server_tick: u64,
    baseline_players_by_id: &HashMap<String, MultiplayerPlayerSnapshot>,
) -> MultiplayerSnapshotDelta {
    let mut next_players_by_id = HashMap::with_capacity(players.len());
    for player in players {
        next_players_by_id.insert(player.player_id.clone(), player);
    }

    let mut upsert_players = players
        .iter()
        .filter(|player| {
            baseline_players_by_id
                .get(player.player_id.as_str())
                .map_or(true, |previous| !snapshots_match(previous, player))
        })
        .cloned()
        .collect::<Vec<_>>();
    upsert_players.sort_by(|a, b| a.player_id.cmp(&b.player_id));

    let mut removed_player_ids = baseline_players_by_id
        .keys()
        .filter(|player_id| !next_players_by_id.contains_key(*player_id))
        .cloned()
        .collect::<Vec<_>>();
    removed_player_ids.sort();

    MultiplayerSnapshotDelta {
        world_id: world_id.to_string(),
        server_tick,
        baseline_server_tick,
        upsert_players,
        removed_player_ids,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiplayerWorldEntitySnapshotDelta {
    pub world_id: String,
    pub server_tick: u64,
    pub baseline_server_tick: u64,
    pub upsert_entities: Vec<SphereEntity>,
    pub removed_entity_ids: Vec<String>,
}

pub fn build_world_entity_snapshot_delta(
    world_id: &str,
    server_tick: u64,
    entities: &[SphereEntity],
    baseline_server_tick: u64,
    baseline_entities_by_id: &HashMap<String, SphereEntity>,
) -> MultiplayerWorldEntitySnapshotDelta {
    let mut next_entities_by_id = HashMap::with_capacity(entities.len());
    for entity in entities {
        next_entities_by_id.insert(entity.id.clone(), entity);
    }

    let mut upsert_entities = entities
        .iter()
        .filter(|entity| {
            baseline_entities_by_id
                .get(entity.id.as_str())
                .map_or(true, |previous| !world_entities_match(previous, entity))
        })
        .cloned()
        .collect::<Vec<_>>();
    upsert_entities.sort_by(|a, b| a.id.cmp(&b.id));

    let mut removed_entity_ids = baseline_entities_by_id
        .keys()
        .filter(|entity_id| !next_entities_by_id.contains_key(*entity_id))
        .cloned()
        .collect::<Vec<_>>();
    removed_entity_ids.sort();

    MultiplayerWorldEntitySnapshotDelta {
        world_id: world_id.to_string(),
        server_tick,
        baseline_server_tick,
        upsert_entities,
        removed_entity_ids,
    }
}

pub fn filter_snapshot_players_for_observer(
    players: &[MultiplayerPlayerSnapshot],
    observer_player_id: &str,
    policy: AoiPolicy,
) -> Vec<MultiplayerPlayerSnapshot> {
    if players.len() <= 1 {
        return players.to_vec();
    }

    let Some(observer) = players
        .iter()
        .find(|player| player.player_id == observer_player_id)
    else {
        // During connect/disconnect churn, fail open rather than dropping entities.
        return players.to_vec();
    };

    let query = policy.query_for(AoiDomain::Players, observer.position_3d);
    let covered_keys = covering_partition_keys(query, policy.partition_cell_edge)
        .into_iter()
        .collect::<HashSet<_>>();
    let candidate_players = players
        .iter()
        .filter(|player| {
            covered_keys.contains(&partition_key(
                player.position_3d,
                policy.partition_cell_edge,
            ))
        })
        .collect::<Vec<_>>();
    let mut included_ids = select_ids_in_query(
        candidate_players,
        query,
        None,
        |player| player.position_3d,
        |player| player.player_id.as_str(),
    )
    .into_iter()
    .collect::<HashSet<_>>();
    included_ids.insert(observer_player_id.to_string());

    let mut filtered = players
        .iter()
        .filter(|player| included_ids.contains(&player.player_id))
        .cloned()
        .collect::<Vec<_>>();
    filtered.sort_by(|a, b| a.player_id.cmp(&b.player_id));
    filtered
}

pub fn filter_snapshot_players_for_focus_context(
    players: &[MultiplayerPlayerSnapshot],
    observer_player_id: &str,
    focus_context_by_player_id: &HashMap<String, Option<String>>,
) -> Vec<MultiplayerPlayerSnapshot> {
    let Some(observer_focus_context) = focus_context_by_player_id.get(observer_player_id) else {
        // During connect/disconnect churn, fail open rather than dropping entities.
        return players.to_vec();
    };

    let mut filtered = players
        .iter()
        .filter(|player| {
            focus_context_by_player_id.get(player.player_id.as_str())
                == Some(observer_focus_context)
        })
        .cloned()
        .collect::<Vec<_>>();
    filtered.sort_by(|a, b| a.player_id.cmp(&b.player_id));
    filtered
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMultiplayerMessage {
    Hello {
        user_id: Option<String>,
        world_id: Option<String>,
        #[serde(default)]
        avatar_id: Option<String>,
        #[serde(default)]
        world_context: Option<MultiplayerWorldContext>,
    },
    PlayerUpdate {
        position_3d: [f32; 3],
        yaw: f32,
        pitch: f32,
        client_tick: u64,
        #[serde(default)]
        avatar_id: Option<String>,
        #[serde(default)]
        world_context: Option<MultiplayerWorldContext>,
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
    StateSnapshotDelta {
        world_id: String,
        server_tick: u64,
        baseline_server_tick: u64,
        upsert_players: Vec<MultiplayerPlayerSnapshot>,
        removed_player_ids: Vec<String>,
    },
    WorldEntitySnapshot {
        world_id: String,
        server_tick: u64,
        entities: Vec<SphereEntity>,
    },
    WorldEntitySnapshotDelta {
        world_id: String,
        server_tick: u64,
        baseline_server_tick: u64,
        upsert_entities: Vec<SphereEntity>,
        removed_entity_ids: Vec<String>,
    },
    WorldCommitApplied {
        world_id: String,
        commit_id: String,
        saved_to: CommitTarget,
        user_id: Option<String>,
        world_context: Option<MultiplayerWorldContext>,
        world: WorldSnapshot,
    },
    ServerReset {
        reason: String,
        world_id: String,
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

    fn set_player_avatar(&mut self, player_id: &str, avatar_id: Option<String>) {
        let Some(normalized_avatar_id) = normalize_avatar_id_option(avatar_id.as_deref()) else {
            return;
        };

        if let Some(player) = self.get_player_mut(player_id) {
            player.avatar_id = normalized_avatar_id;
        }
    }

    fn set_player_context(
        &mut self,
        player_id: &str,
        world_context: Option<MultiplayerWorldContext>,
    ) {
        if let Some(player) = self.get_player_mut(player_id) {
            let normalized_world_context =
                normalize_world_context(player.world_id.as_str(), world_context);
            player.world_context = normalized_world_context;
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
        world_context: Option<MultiplayerWorldContext>,
    ) -> PlayerInputEnqueueResult {
        let Some(world_id) = self.world_by_player_id.get(player_id).cloned() else {
            return PlayerInputEnqueueResult::PlayerMissing;
        };

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

        let normalized_world_context = normalize_world_context(world_id.as_str(), world_context);

        pending.insert(
            client_tick,
            PlayerInputCommand {
                client_tick,
                position_3d,
                yaw,
                pitch,
                avatar_id: normalize_avatar_id_option(avatar_id.as_deref()),
                world_context: normalized_world_context,
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
                    player.world_context = command.world_context;
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

    fn player_world_context_key(&self, player_id: &str) -> Option<String> {
        let world_id = self.world_by_player_id.get(player_id)?;
        let player = self.by_world.get(world_id)?.get(player_id)?;
        world_context_key(player.world_context.as_ref())
    }

    fn player_visible_to_others(&self, player_id: &str) -> bool {
        let Some(world_id) = self.world_by_player_id.get(player_id) else {
            return true;
        };
        let Some(world_players) = self.by_world.get(world_id) else {
            return true;
        };
        world_players
            .get(player_id)
            .map(|player| player.visible_to_others)
            .unwrap_or(true)
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

    #[cfg(test)]
    pub async fn add_player(&self, user_id: String, world_id: String) -> MultiplayerPlayerState {
        self.add_player_with_visibility(user_id, world_id, true)
            .await
    }

    pub async fn add_player_with_visibility(
        &self,
        user_id: String,
        world_id: String,
        visible_to_others: bool,
    ) -> MultiplayerPlayerState {
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
            world_context: None,
            visible_to_others,
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

    pub async fn set_player_avatar(&self, player_id: &str, avatar_id: Option<String>) {
        self.players
            .write()
            .await
            .set_player_avatar(player_id, avatar_id);
    }

    pub async fn set_player_context(
        &self,
        player_id: &str,
        world_context: Option<MultiplayerWorldContext>,
    ) {
        self.players
            .write()
            .await
            .set_player_context(player_id, world_context);
    }

    #[cfg(test)]
    pub async fn update_player(
        &self,
        player_id: &str,
        position_3d: [f32; 3],
        yaw: f32,
        pitch: f32,
        client_tick: u64,
        avatar_id: Option<String>,
    ) -> PlayerInputEnqueueResult {
        self.update_player_with_world_context(
            player_id,
            position_3d,
            yaw,
            pitch,
            client_tick,
            avatar_id,
            None,
        )
        .await
    }

    pub async fn update_player_with_world_context(
        &self,
        player_id: &str,
        position_3d: [f32; 3],
        yaw: f32,
        pitch: f32,
        client_tick: u64,
        avatar_id: Option<String>,
        world_context: Option<MultiplayerWorldContext>,
    ) -> PlayerInputEnqueueResult {
        self.players.write().await.update_player_pose(
            player_id,
            client_tick,
            position_3d,
            yaw,
            pitch,
            avatar_id,
            world_context,
        )
    }

    pub async fn filter_snapshot_players_for_observer_focus_context(
        &self,
        players: &[MultiplayerPlayerSnapshot],
        observer_player_id: &str,
    ) -> Vec<MultiplayerPlayerSnapshot> {
        let store = self.players.read().await;
        let mut focus_context_by_player_id = HashMap::with_capacity(players.len() + 1);
        for player in players {
            focus_context_by_player_id.insert(
                player.player_id.clone(),
                store.player_world_context_key(player.player_id.as_str()),
            );
        }

        if !focus_context_by_player_id.contains_key(observer_player_id) {
            focus_context_by_player_id.insert(
                observer_player_id.to_string(),
                store.player_world_context_key(observer_player_id),
            );
        }

        filter_snapshot_players_for_focus_context(
            players,
            observer_player_id,
            &focus_context_by_player_id,
        )
    }

    pub async fn filter_snapshot_players_for_observer_visibility(
        &self,
        players: &[MultiplayerPlayerSnapshot],
        observer_player_id: &str,
    ) -> Vec<MultiplayerPlayerSnapshot> {
        let store = self.players.read().await;
        let mut filtered = players
            .iter()
            .filter(|player| {
                player.player_id == observer_player_id
                    || store.player_visible_to_others(player.player_id.as_str())
            })
            .cloned()
            .collect::<Vec<_>>();
        filtered.sort_by(|a, b| a.player_id.cmp(&b.player_id));
        filtered
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
        world_context: Option<MultiplayerWorldContext>,
        world: WorldSnapshot,
    ) {
        let _ = self.tx.send(ServerMultiplayerMessage::WorldCommitApplied {
            world_id,
            commit_id,
            saved_to,
            user_id,
            world_context,
            world,
        });
    }

    pub fn broadcast_server_reset(&self, reason: String, world_id: String) {
        let _ = self
            .tx
            .send(ServerMultiplayerMessage::ServerReset { reason, world_id });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_snapshot_delta, build_world_entity_snapshot_delta,
        filter_snapshot_players_for_focus_context, filter_snapshot_players_for_observer,
        normalize_world_context, snapshot_players_by_id, world_entities_by_id, MultiplayerHub,
        MultiplayerPlayerSnapshot, MultiplayerWorldContext, PlayerInputEnqueueResult,
        ServerMultiplayerMessage,
    };
    use crate::aoi::AoiPolicy;
    use crate::protocol::{example_world_snapshot, CommitTarget, SphereEntity, TimeWindow};
    use std::collections::{BTreeMap, HashMap};
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
    async fn set_player_avatar_applies_without_pose_update() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let mut rx = hub.subscribe();
        let player = hub
            .add_player("user-avatar-hello".to_string(), "world-main".to_string())
            .await;

        hub.set_player_avatar(&player.player_id, Some("human".to_string()))
            .await;
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
            "expected hello-time avatar snapshot within timeout"
        );

        hub.set_player_avatar(&player.player_id, Some("robot".to_string()))
            .await;
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
            "expected normalized hello-time avatar snapshot within timeout"
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

    #[test]
    fn filter_snapshot_players_for_observer_applies_aoi_radius() {
        let players = vec![
            MultiplayerPlayerSnapshot {
                player_id: "player-observer".to_string(),
                position_3d: [0.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "player-near".to_string(),
                position_3d: [10.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "human".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "player-far".to_string(),
                position_3d: [100.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
        ];

        let filtered =
            filter_snapshot_players_for_observer(&players, "player-observer", AoiPolicy::default());
        let ids = filtered
            .iter()
            .map(|player| player.player_id.clone())
            .collect::<Vec<_>>();

        assert!(ids.iter().any(|id| id == "player-observer"));
        assert!(ids.iter().any(|id| id == "player-near"));
        assert!(!ids.iter().any(|id| id == "player-far"));
    }

    #[test]
    fn filter_snapshot_players_for_observer_is_deterministic_and_fails_open_when_missing() {
        let players = vec![
            MultiplayerPlayerSnapshot {
                player_id: "a".to_string(),
                position_3d: [0.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "b".to_string(),
                position_3d: [12.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "c".to_string(),
                position_3d: [80.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
        ];

        let first = filter_snapshot_players_for_observer(&players, "a", AoiPolicy::default());
        let second = filter_snapshot_players_for_observer(&players, "a", AoiPolicy::default());
        assert_eq!(first.len(), second.len());
        for index in 0..first.len() {
            assert_eq!(first[index].player_id, second[index].player_id);
        }

        let missing =
            filter_snapshot_players_for_observer(&players, "missing-player", AoiPolicy::default());
        assert_eq!(missing.len(), players.len());
    }

    #[test]
    fn filter_snapshot_players_for_focus_context_partitions_like_world_contexts() {
        let players = vec![
            MultiplayerPlayerSnapshot {
                player_id: "observer".to_string(),
                position_3d: [0.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "other".to_string(),
                position_3d: [1.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "human".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "peer-focused".to_string(),
                position_3d: [2.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
        ];
        let mut focus_context_by_player_id = HashMap::<String, Option<String>>::new();
        focus_context_by_player_id.insert(
            "observer".to_string(),
            Some("sphere-template-root-1".to_string()),
        );
        focus_context_by_player_id.insert("other".to_string(), None);
        focus_context_by_player_id.insert(
            "peer-focused".to_string(),
            Some("sphere-template-root-1".to_string()),
        );

        let focused = filter_snapshot_players_for_focus_context(
            &players,
            "observer",
            &focus_context_by_player_id,
        );
        assert_eq!(focused.len(), 2);
        assert_eq!(focused[0].player_id, "observer");
        assert_eq!(focused[1].player_id, "peer-focused");

        let unfocused = filter_snapshot_players_for_focus_context(
            &players,
            "other",
            &focus_context_by_player_id,
        );
        assert_eq!(unfocused.len(), 1);
        assert_eq!(unfocused[0].player_id, "other");

        let missing_observer = filter_snapshot_players_for_focus_context(
            &players,
            "missing-observer",
            &focus_context_by_player_id,
        );
        assert_eq!(missing_observer.len(), players.len());
    }

    #[test]
    fn normalize_world_context_prefers_non_empty_instance_path() {
        let context = normalize_world_context(
            "world-main",
            Some(MultiplayerWorldContext {
                root_world_id: "world-main".to_string(),
                instance_path: vec!["sphere-template-root-1".to_string()],
            }),
        )
        .expect("normalized world context");

        assert_eq!(context.root_world_id, "world-main");
        assert_eq!(
            context.instance_path,
            vec!["sphere-template-root-1".to_string()]
        );
    }

    #[test]
    fn normalize_world_context_returns_none_when_instance_path_is_empty() {
        let context = normalize_world_context(
            "world-main",
            Some(MultiplayerWorldContext {
                root_world_id: "world-main".to_string(),
                instance_path: Vec::new(),
            }),
        );
        assert_eq!(context, None);
    }

    #[tokio::test]
    async fn hidden_players_are_not_visible_to_other_observers() {
        let hub = MultiplayerHub::new_without_snapshot_loop();
        let mut rx = hub.subscribe();

        let visible_player = hub
            .add_player("user-visible".to_string(), "world-main".to_string())
            .await;
        let hidden_player = hub
            .add_player_with_visibility("user-hidden".to_string(), "world-main".to_string(), false)
            .await;

        hub.broadcast_world_snapshot("world-main").await;

        let snapshot_players = timeout(Duration::from_millis(200), async {
            loop {
                let received = rx.recv().await.expect("state snapshot message");
                match received {
                    ServerMultiplayerMessage::StateSnapshot {
                        world_id, players, ..
                    } if world_id == "world-main" => {
                        return players;
                    }
                    _ => continue,
                }
            }
        })
        .await
        .expect("expected world snapshot within timeout");

        let visible_observer = hub
            .filter_snapshot_players_for_observer_visibility(
                &snapshot_players,
                visible_player.player_id.as_str(),
            )
            .await;
        assert!(visible_observer
            .iter()
            .any(|item| item.player_id == visible_player.player_id));
        assert!(visible_observer
            .iter()
            .all(|item| item.player_id != hidden_player.player_id));

        let hidden_observer = hub
            .filter_snapshot_players_for_observer_visibility(
                &snapshot_players,
                hidden_player.player_id.as_str(),
            )
            .await;
        assert!(hidden_observer
            .iter()
            .any(|item| item.player_id == hidden_player.player_id));
        assert!(hidden_observer
            .iter()
            .any(|item| item.player_id == visible_player.player_id));
    }

    #[test]
    fn build_snapshot_delta_tracks_upserts_and_removals_against_baseline() {
        let baseline_players = vec![
            MultiplayerPlayerSnapshot {
                player_id: "player-a".to_string(),
                position_3d: [0.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "player-b".to_string(),
                position_3d: [10.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
        ];
        let next_players = vec![
            MultiplayerPlayerSnapshot {
                player_id: "player-a".to_string(),
                position_3d: [1.0, 0.0, 0.0],
                yaw: 0.1,
                pitch: 0.0,
                avatar_id: "human".to_string(),
                last_processed_input_tick: 2,
            },
            MultiplayerPlayerSnapshot {
                player_id: "player-c".to_string(),
                position_3d: [4.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
        ];
        let baseline_by_id = snapshot_players_by_id(&baseline_players);
        let delta = build_snapshot_delta("world-main", 22, &next_players, 21, &baseline_by_id);

        assert_eq!(delta.world_id, "world-main");
        assert_eq!(delta.server_tick, 22);
        assert_eq!(delta.baseline_server_tick, 21);
        assert_eq!(delta.removed_player_ids, vec!["player-b".to_string()]);
        assert_eq!(delta.upsert_players.len(), 2);
        assert_eq!(delta.upsert_players[0].player_id, "player-a");
        assert_eq!(delta.upsert_players[1].player_id, "player-c");
    }

    #[test]
    fn build_snapshot_delta_is_empty_when_state_matches_baseline() {
        let players = vec![
            MultiplayerPlayerSnapshot {
                player_id: "player-a".to_string(),
                position_3d: [0.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "duck".to_string(),
                last_processed_input_tick: 1,
            },
            MultiplayerPlayerSnapshot {
                player_id: "player-b".to_string(),
                position_3d: [1.0, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                avatar_id: "human".to_string(),
                last_processed_input_tick: 3,
            },
        ];
        let baseline_by_id = snapshot_players_by_id(&players);
        let delta = build_snapshot_delta("world-main", 10, &players, 9, &baseline_by_id);

        assert!(delta.upsert_players.is_empty());
        assert!(delta.removed_player_ids.is_empty());
    }

    fn make_world_entity(id: &str, position_3d: [f32; 3], radius: f32) -> SphereEntity {
        SphereEntity {
            id: id.to_string(),
            parent_id: Some("sphere-world-001".to_string()),
            radius,
            position_3d,
            dimensions: BTreeMap::from([("money".to_string(), 0.2), ("heat".to_string(), 0.4)]),
            instance_world_id: None,
            time_window: TimeWindow {
                start_tick: 0,
                end_tick: None,
            },
            tags: vec!["resource".to_string()],
        }
    }

    #[test]
    fn build_world_entity_snapshot_delta_tracks_upserts_and_removals() {
        let baseline_entities = vec![
            make_world_entity("entity-a", [0.0, 0.0, 0.0], 1.0),
            make_world_entity("entity-b", [1.0, 0.0, 0.0], 1.0),
        ];
        let next_entities = vec![
            make_world_entity("entity-a", [0.5, 0.0, 0.0], 1.0),
            make_world_entity("entity-c", [2.0, 0.0, 0.0], 1.2),
        ];
        let baseline_by_id = world_entities_by_id(&baseline_entities);
        let delta = build_world_entity_snapshot_delta(
            "world-main",
            12,
            &next_entities,
            11,
            &baseline_by_id,
        );

        assert_eq!(delta.world_id, "world-main");
        assert_eq!(delta.server_tick, 12);
        assert_eq!(delta.baseline_server_tick, 11);
        assert_eq!(delta.removed_entity_ids, vec!["entity-b".to_string()]);
        assert_eq!(delta.upsert_entities.len(), 2);
        assert_eq!(delta.upsert_entities[0].id, "entity-a");
        assert_eq!(delta.upsert_entities[1].id, "entity-c");
    }

    #[test]
    fn build_world_entity_snapshot_delta_is_empty_when_state_matches_baseline() {
        let entities = vec![
            make_world_entity("entity-a", [0.0, 0.0, 0.0], 1.0),
            make_world_entity("entity-b", [1.0, 0.0, 0.0], 1.0),
        ];
        let baseline_by_id = world_entities_by_id(&entities);
        let delta =
            build_world_entity_snapshot_delta("world-main", 12, &entities, 11, &baseline_by_id);

        assert!(delta.upsert_entities.is_empty());
        assert!(delta.removed_entity_ids.is_empty());
    }
}
