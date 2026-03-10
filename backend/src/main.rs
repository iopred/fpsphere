mod aoi;
mod datastore;
mod hshg;
mod multiplayer;
mod protocol;

use aoi::AoiPolicy;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use datastore::FileWorldDatastore;
use hshg::{HierarchicalSpatialHashGrid, HshgEntry};
use multiplayer::{
    build_snapshot_delta, build_world_entity_snapshot_delta, filter_snapshot_players_for_observer,
    master_world_commit_context_matches, normalize_world_context, snapshot_players_by_id,
    world_entities_by_id, ClientMultiplayerMessage, MultiplayerHub, MultiplayerPlayerSnapshot,
    MultiplayerWorldContext, PlayerInputEnqueueResult, ServerMultiplayerMessage,
};
use protocol::{
    example_seed_world_snapshots, CommitFailure, CommitOperation, CommitRequest, CommitResponse,
    CommitTarget, SphereEntity, TemporalWorldQuery, WorldMutationFailure, WorldRepository,
    WorldSnapshot,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::io::{self, AsyncBufReadExt, BufReader};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{watch, RwLock};

const SNAPSHOT_DELTA_REBASE_INTERVAL: u32 = 90;
const DEFAULT_DATASTORE_PATH: &str = "data/world-repository.json";
const WORLD_ENTITY_HSHG_MAX_LEVELS: u8 = 7;

#[derive(Clone)]
struct AppState {
    repository: Arc<RwLock<WorldRepository>>,
    seed_worlds: Vec<WorldSnapshot>,
    datastore: Arc<FileWorldDatastore>,
    multiplayer: MultiplayerHub,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[derive(Debug, Deserialize)]
struct GetWorldQuery {
    user_id: Option<String>,
    tick: Option<u64>,
    window_start_tick: Option<u64>,
    window_end_tick: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    user_id: Option<String>,
    world_id: Option<String>,
    visibility_mode: Option<String>,
}

#[derive(Debug, Serialize)]
struct CommitErrorResponse {
    status: &'static str,
    message: String,
    validation_errors: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CommitRequestEnvelope {
    user_id: String,
    base_tick: u64,
    operations: Vec<CommitOperation>,
    #[serde(default)]
    world_context: Option<MultiplayerWorldContext>,
}

#[derive(Debug, Serialize)]
struct WorldListResponse {
    world_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct CreateWorldRequest {
    world_id: String,
}

#[derive(Debug, Serialize)]
struct WorldMutationResponse {
    world_id: String,
}

#[derive(Debug, Serialize)]
struct WorldMutationErrorResponse {
    status: &'static str,
    message: String,
}

struct SessionSnapshotBaseline {
    server_tick: u64,
    players_by_id: HashMap<String, MultiplayerPlayerSnapshot>,
    delta_frames_since_full: u32,
}

struct SessionWorldEntityBaseline {
    server_tick: u64,
    entities_by_id: HashMap<String, SphereEntity>,
    delta_frames_since_full: u32,
}

struct SessionMessageUpdate {
    updated_user_id: Option<String>,
    updated_world_context: Option<MultiplayerWorldContext>,
}

fn visible_to_others_from_mode(raw_mode: Option<&str>) -> bool {
    let Some(mode) = raw_mode.map(str::trim).filter(|value| !value.is_empty()) else {
        return true;
    };

    !mode.eq_ignore_ascii_case("hidden")
}

fn should_deliver_master_world_commit_for_context(
    session_world_context: Option<&MultiplayerWorldContext>,
    commit_world_context: Option<&MultiplayerWorldContext>,
) -> bool {
    master_world_commit_context_matches(session_world_context, commit_world_context)
}

fn should_deliver_world_commit_for_session(
    session_world_id: &str,
    session_user_id: &str,
    session_world_context: Option<&MultiplayerWorldContext>,
    commit_world_id: &str,
    saved_to: &CommitTarget,
    target_user_id: Option<&str>,
    commit_world_context: Option<&MultiplayerWorldContext>,
) -> bool {
    match saved_to {
        CommitTarget::Master => {
            if commit_world_id == session_world_id {
                return should_deliver_master_world_commit_for_context(
                    session_world_context,
                    commit_world_context,
                );
            }

            true
        }
        CommitTarget::User => {
            if commit_world_id != session_world_id {
                return false;
            }

            target_user_id
                .map(|value| value == session_user_id)
                .unwrap_or(false)
        }
    }
}

fn world_context_focus_sphere_id(world_context: Option<&MultiplayerWorldContext>) -> Option<&str> {
    world_context?.instance_path.last().map(String::as_str)
}

fn collect_context_entities(
    world: &WorldSnapshot,
    world_context: Option<&MultiplayerWorldContext>,
) -> Vec<SphereEntity> {
    let mut entities_by_id = HashMap::<String, &SphereEntity>::with_capacity(world.entities.len());
    let mut children_by_parent = HashMap::<String, Vec<String>>::new();

    for entity in &world.entities {
        entities_by_id.insert(entity.id.clone(), entity);
        if let Some(parent_id) = &entity.parent_id {
            children_by_parent
                .entry(parent_id.clone())
                .or_default()
                .push(entity.id.clone());
        }
    }

    if let Some(focus_sphere_id) = world_context_focus_sphere_id(world_context) {
        let focus_id = focus_sphere_id.trim();
        if let Some(focus_entity) = entities_by_id.get(focus_id) {
            let mut included_ids = HashSet::<String>::new();
            let mut stack = vec![focus_entity.id.clone()];
            while let Some(current_id) = stack.pop() {
                if !included_ids.insert(current_id.clone()) {
                    continue;
                }
                if let Some(children) = children_by_parent.get(current_id.as_str()) {
                    stack.extend(children.iter().cloned());
                }
            }

            let mut filtered = world
                .entities
                .iter()
                .filter(|entity| included_ids.contains(entity.id.as_str()))
                .cloned()
                .collect::<Vec<_>>();
            filtered.sort_by(|left, right| left.id.cmp(&right.id));
            return filtered;
        }
    }

    let template_root_ids = world
        .entities
        .iter()
        .filter(|entity| entity.tags.iter().any(|tag| tag == "template-root"))
        .map(|entity| entity.id.clone())
        .collect::<HashSet<_>>();
    if template_root_ids.is_empty() {
        let mut all_entities = world.entities.clone();
        all_entities.sort_by(|left, right| left.id.cmp(&right.id));
        return all_entities;
    }

    let mut filtered = Vec::<SphereEntity>::new();
    'entity: for entity in &world.entities {
        if template_root_ids.contains(entity.id.as_str()) {
            continue;
        }

        let mut cursor_parent_id = entity.parent_id.clone();
        while let Some(parent_id) = cursor_parent_id {
            if template_root_ids.contains(parent_id.as_str()) {
                continue 'entity;
            }

            cursor_parent_id = entities_by_id
                .get(parent_id.as_str())
                .and_then(|parent| parent.parent_id.clone());
        }

        filtered.push(entity.clone());
    }

    filtered.sort_by(|left, right| left.id.cmp(&right.id));
    filtered
}

fn filter_context_entities_for_observer(
    entities: &[SphereEntity],
    observer_position: [f32; 3],
    policy: AoiPolicy,
) -> Vec<SphereEntity> {
    let query = policy.query_for(aoi::AoiDomain::WorldEntities, observer_position);
    if entities.is_empty() || query.max_results == 0 {
        return Vec::new();
    }

    let mut index =
        HierarchicalSpatialHashGrid::new(policy.partition_cell_edge, WORLD_ENTITY_HSHG_MAX_LEVELS);
    index.rebuild(entities.iter().map(|entity| HshgEntry {
        id: entity.id.clone(),
        center: entity.position_3d,
        radius: entity.radius,
    }));

    let included_ids = index
        .query_radius(query.center, query.radius, query.max_results)
        .into_iter()
        .collect::<HashSet<_>>();
    let mut filtered = entities
        .iter()
        .filter(|entity| included_ids.contains(entity.id.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    filtered.sort_by(|left, right| left.id.cmp(&right.id));
    filtered
}

#[tokio::main]
async fn main() {
    let _ = dotenvy::from_filename(".env");

    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "fpsphere_backend=debug,tower_http=debug".to_string()),
        )
        .init();

    let seed_worlds = example_seed_world_snapshots();
    let datastore_path = std::env::var("WORLD_DATASTORE_PATH")
        .unwrap_or_else(|_| DEFAULT_DATASTORE_PATH.to_string());
    let datastore = Arc::new(FileWorldDatastore::new(datastore_path));
    let repository = load_repository(datastore.as_ref(), &seed_worlds).await;
    let multiplayer = MultiplayerHub::new();

    let app_state = AppState {
        repository: Arc::new(RwLock::new(repository)),
        seed_worlds,
        datastore: datastore.clone(),
        multiplayer,
    };
    if let Err(error) = persist_repository_snapshot(&app_state).await {
        tracing::error!("failed to persist initial datastore snapshot: {}", error);
    }

    let app = Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/worlds", get(list_worlds))
        .route("/api/v1/world", post(create_world))
        .route(
            "/api/v1/world/{world_id}",
            get(get_world_snapshot).delete(delete_world),
        )
        .route("/api/v1/world/{world_id}/commit", post(commit_world))
        .route("/ws", get(ws_handler))
        .with_state(app_state.clone());

    let bind_address = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:4000".to_string())
        .parse::<SocketAddr>()
        .expect("BIND_ADDR must be a valid socket address, e.g. 127.0.0.1:4000");
    tracing::info!("backend listening on {}", bind_address);

    let listener = tokio::net::TcpListener::bind(bind_address)
        .await
        .expect("bind backend listener");
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let admin_console = tokio::spawn(run_admin_console(app_state.clone(), shutdown_tx.clone()));

    axum::serve(listener, app)
        .with_graceful_shutdown(wait_for_shutdown_signal(shutdown_rx))
        .await
        .expect("start backend server");

    let _ = shutdown_tx.send(true);
    admin_console.abort();
}

async fn load_repository(
    datastore: &FileWorldDatastore,
    seed_worlds: &[WorldSnapshot],
) -> WorldRepository {
    match datastore.load().await {
        Ok(Some(state)) => match WorldRepository::from_persisted_state(state) {
            Ok(repository) => {
                tracing::info!("loaded world datastore from {}", datastore.path().display());
                repository
            }
            Err(error) => {
                tracing::warn!(
                    "invalid persisted datastore state ({}); using seed snapshot",
                    error
                );
                WorldRepository::new_with_worlds(seed_worlds.to_vec())
                    .expect("seed worlds must be valid")
            }
        },
        Ok(None) => {
            tracing::info!(
                "no datastore file found at {}; using seed snapshot",
                datastore.path().display()
            );
            WorldRepository::new_with_worlds(seed_worlds.to_vec())
                .expect("seed worlds must be valid")
        }
        Err(error) => {
            tracing::warn!(
                "failed to read datastore at {} ({}); using seed snapshot",
                datastore.path().display(),
                error
            );
            WorldRepository::new_with_worlds(seed_worlds.to_vec())
                .expect("seed worlds must be valid")
        }
    }
}

async fn persist_repository_snapshot(state: &AppState) -> Result<(), String> {
    let persisted = {
        let repository = state.repository.read().await;
        repository.to_persisted_state()
    };

    state
        .datastore
        .save(&persisted)
        .await
        .map_err(|error| error.to_string())
}

async fn reset_server_data(state: &AppState, reason: &str) {
    let world = {
        let mut repository = state.repository.write().await;
        repository
            .reset_to_seed_worlds(state.seed_worlds.clone())
            .expect("seed worlds must include at least one world")
    };
    if let Err(error) = persist_repository_snapshot(state).await {
        tracing::error!("failed to persist reset datastore snapshot: {}", error);
    }

    state
        .multiplayer
        .broadcast_server_reset(reason.to_string(), world.world_id.clone());
    state.multiplayer.broadcast_world_commit(
        world.world_id.clone(),
        "server-reset".to_string(),
        CommitTarget::Master,
        None,
        None,
        world,
    );
}

async fn run_admin_console(state: AppState, shutdown_tx: watch::Sender<bool>) {
    tracing::info!("admin console ready: commands are `help`, `reset`, `exit`");

    let mut lines = BufReader::new(io::stdin()).lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(value)) => value,
            Ok(None) => break,
            Err(error) => {
                tracing::error!("admin console read failed: {}", error);
                break;
            }
        };

        let command = line.trim();
        if command.is_empty() {
            continue;
        }

        match command {
            "help" => {
                tracing::info!("admin commands: `help`, `reset`, `exit`");
            }
            "reset" => {
                tracing::info!("admin reset requested");
                reset_server_data(&state, "admin reset").await;
                tracing::info!("world reset complete");
            }
            "exit" | "quit" => {
                tracing::info!("admin shutdown requested");
                let _ = shutdown_tx.send(true);
                break;
            }
            unknown => {
                tracing::warn!("unknown admin command '{}'; try `help`", unknown);
            }
        }
    }
}

async fn wait_for_shutdown_signal(mut shutdown_rx: watch::Receiver<bool>) {
    tokio::select! {
        result = shutdown_rx.changed() => {
            if result.is_ok() && *shutdown_rx.borrow() {
                tracing::info!("shutdown signal received from admin console");
            }
        }
        result = tokio::signal::ctrl_c() => {
            if result.is_ok() {
                tracing::info!("shutdown signal received from ctrl+c");
            }
        }
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "fpsphere-backend",
    })
}

async fn list_worlds(State(state): State<AppState>) -> Json<WorldListResponse> {
    let repository = state.repository.read().await;
    Json(WorldListResponse {
        world_ids: repository.list_world_ids(),
    })
}

async fn create_world(
    State(state): State<AppState>,
    Json(request): Json<CreateWorldRequest>,
) -> Result<(StatusCode, Json<WorldMutationResponse>), (StatusCode, Json<WorldMutationErrorResponse>)>
{
    let world_seed = state
        .seed_worlds
        .iter()
        .find(|world| world.world_id == "world-main")
        .or_else(|| state.seed_worlds.first())
        .cloned();

    let response = {
        let mut repository = state.repository.write().await;
        match world_seed {
            Some(seed_world) => repository.create_world_from_seed(&request.world_id, seed_world),
            None => Err(WorldMutationFailure::WorldNotFound {
                message: "unable to create world: no seed world exists".to_string(),
            }),
        }
    };

    match response {
        Ok(world) => {
            if let Err(error) = persist_repository_snapshot(&state).await {
                tracing::error!("failed to persist datastore after world create: {}", error);
            }

            Ok((
                StatusCode::CREATED,
                Json(WorldMutationResponse {
                    world_id: world.world_id,
                }),
            ))
        }
        Err(WorldMutationFailure::InvalidWorldId { message }) => Err((
            StatusCode::BAD_REQUEST,
            Json(WorldMutationErrorResponse {
                status: "error",
                message,
            }),
        )),
        Err(WorldMutationFailure::WorldAlreadyExists { message }) => Err((
            StatusCode::CONFLICT,
            Json(WorldMutationErrorResponse {
                status: "error",
                message,
            }),
        )),
        Err(error @ WorldMutationFailure::WorldNotFound { .. })
        | Err(error @ WorldMutationFailure::LastWorldRemovalForbidden { .. }) => Err((
            StatusCode::CONFLICT,
            Json(WorldMutationErrorResponse {
                status: "error",
                message: error.message(),
            }),
        )),
    }
}

async fn get_world_snapshot(
    Path(world_id): Path<String>,
    Query(query): Query<GetWorldQuery>,
    State(state): State<AppState>,
) -> Result<Json<WorldSnapshot>, StatusCode> {
    let temporal_query = TemporalWorldQuery {
        tick: query.tick,
        window_start_tick: query.window_start_tick,
        window_end_tick: query.window_end_tick,
    };
    if temporal_query.validate().is_err() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let resolved_temporal_query = (!temporal_query.is_empty()).then_some(temporal_query);

    let repository = state.repository.read().await;
    let snapshot = match resolved_temporal_query {
        Some(temporal_query) => repository.get_world_snapshot_with_query(
            &world_id,
            query.user_id.as_deref(),
            Some(temporal_query),
        ),
        None => repository.get_world_snapshot(&world_id, query.user_id.as_deref()),
    };

    match snapshot {
        Some(world) => Ok(Json(world)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn commit_world(
    Path(world_id): Path<String>,
    State(state): State<AppState>,
    Json(request): Json<CommitRequestEnvelope>,
) -> Result<Json<CommitResponse>, (StatusCode, Json<CommitErrorResponse>)> {
    if request.user_id.trim().is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(CommitErrorResponse {
                status: "error",
                message: "user_id is required".to_string(),
                validation_errors: vec![],
            }),
        ));
    }

    if request.operations.is_empty() {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(CommitErrorResponse {
                status: "error",
                message: "commit must include at least one operation".to_string(),
                validation_errors: vec![],
            }),
        ));
    }

    let commit_request = CommitRequest {
        user_id: request.user_id.clone(),
        base_tick: request.base_tick,
        operations: request.operations.clone(),
    };
    let request_user_id = request.user_id.clone();
    let response = {
        let mut repository = state.repository.write().await;
        repository.commit(&world_id, commit_request)
    };

    match response {
        Ok(commit_response) => {
            let saved_to = commit_response.saved_to.clone();
            let commit_world_context = normalize_world_context(&world_id, request.world_context);
            let user_scope = match &saved_to {
                CommitTarget::Master => None,
                CommitTarget::User => Some(request_user_id),
            };
            state.multiplayer.broadcast_world_commit(
                world_id.clone(),
                commit_response.commit_id.clone(),
                saved_to,
                user_scope,
                commit_world_context,
                commit_response.world.clone(),
            );
            if let Err(error) = persist_repository_snapshot(&state).await {
                tracing::error!("failed to persist datastore after commit: {}", error);
            }

            Ok(Json(commit_response))
        }
        Err(CommitFailure::WorldNotFound { message }) => Err((
            StatusCode::NOT_FOUND,
            Json(CommitErrorResponse {
                status: "error",
                message,
                validation_errors: vec![],
            }),
        )),
        Err(error @ CommitFailure::InvalidOperations { .. }) => Err((
            StatusCode::CONFLICT,
            Json(CommitErrorResponse {
                status: "error",
                message: error.message(),
                validation_errors: error.validation_errors(),
            }),
        )),
    }
}

async fn delete_world(
    Path(world_id): Path<String>,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, Json<WorldMutationErrorResponse>)> {
    let response = {
        let mut repository = state.repository.write().await;
        repository.delete_world(&world_id)
    };

    match response {
        Ok(()) => {
            if let Err(error) = persist_repository_snapshot(&state).await {
                tracing::error!("failed to persist datastore after world delete: {}", error);
            }
            Ok(StatusCode::NO_CONTENT)
        }
        Err(WorldMutationFailure::WorldNotFound { message }) => Err((
            StatusCode::NOT_FOUND,
            Json(WorldMutationErrorResponse {
                status: "error",
                message,
            }),
        )),
        Err(error @ WorldMutationFailure::LastWorldRemovalForbidden { .. })
        | Err(error @ WorldMutationFailure::InvalidWorldId { .. })
        | Err(error @ WorldMutationFailure::WorldAlreadyExists { .. }) => Err((
            StatusCode::CONFLICT,
            Json(WorldMutationErrorResponse {
                status: "error",
                message: error.message(),
            }),
        )),
    }
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(query): Query<WsQuery>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    let user_id = query.user_id.unwrap_or_else(|| "anon".to_string());
    let world_id = query.world_id.unwrap_or_else(|| "world-main".to_string());
    let visible_to_others = visible_to_others_from_mode(query.visibility_mode.as_deref());

    ws.on_upgrade(move |socket| {
        handle_ws_connection(socket, state, user_id, world_id, visible_to_others)
    })
}

async fn handle_ws_connection(
    mut socket: WebSocket,
    state: AppState,
    user_id: String,
    world_id: String,
    visible_to_others: bool,
) {
    let mut rx = state.multiplayer.subscribe();
    let mut session_user_id = user_id;
    let mut session_world_context: Option<MultiplayerWorldContext> = None;
    let mut snapshot_baseline: Option<SessionSnapshotBaseline> = None;
    let mut world_entity_baseline: Option<SessionWorldEntityBaseline> = None;
    let player = state
        .multiplayer
        .add_player_with_visibility(session_user_id.clone(), world_id.clone(), visible_to_others)
        .await;

    let welcome = ServerMultiplayerMessage::Welcome {
        player_id: player.player_id.clone(),
        user_id: session_user_id.clone(),
        world_id: world_id.clone(),
    };
    if send_ws_message(&mut socket, &welcome).await.is_err() {
        state.multiplayer.remove_player(&player.player_id).await;
        return;
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(message)) => {
                        match message {
                            Message::Text(text) => {
                                match handle_client_message(
                                    &state,
                                    &mut socket,
                                    &player.player_id,
                                    &world_id,
                                    text.as_str(),
                                )
                                .await
                                {
                                    Ok(Some(update)) => {
                                        if let Some(updated_user_id) = update.updated_user_id {
                                            session_user_id = updated_user_id;
                                        }
                                        session_world_context = update.updated_world_context;
                                    }
                                    Ok(None) => {}
                                    Err(()) => break,
                                }
                            }
                            Message::Close(_) => break,
                            Message::Ping(payload) => {
                                if socket.send(Message::Pong(payload)).await.is_err() {
                                    break;
                                }
                            }
                            Message::Pong(_) => {}
                            Message::Binary(_) => {}
                        }
                    }
                    Some(Err(_)) => break,
                    None => break,
                }
            }
            outbound = rx.recv() => {
                match outbound {
                    Ok(ServerMultiplayerMessage::StateSnapshot { world_id: snapshot_world_id, server_tick, players }) => {
                        if snapshot_world_id == world_id {
                            let filtered_players = filter_snapshot_players_for_observer(
                                &players,
                                player.player_id.as_str(),
                                AoiPolicy::default(),
                            );
                            let filtered_players = state
                                .multiplayer
                                .filter_snapshot_players_for_observer_focus_context(
                                    &filtered_players,
                                    player.player_id.as_str(),
                                )
                                .await;
                            let filtered_players = state
                                .multiplayer
                                .filter_snapshot_players_for_observer_visibility(
                                    &filtered_players,
                                    player.player_id.as_str(),
                                )
                                .await;
                            let next_players_by_id = snapshot_players_by_id(&filtered_players);
                            let observer_position = filtered_players
                                .iter()
                                .find(|candidate| candidate.player_id == player.player_id)
                                .map(|candidate| candidate.position_3d)
                                .unwrap_or([0.0, -2.5, 16.0]);
                            let should_force_full = snapshot_baseline
                                .as_ref()
                                .map_or(true, |baseline| {
                                    baseline.delta_frames_since_full >= SNAPSHOT_DELTA_REBASE_INTERVAL
                                        || server_tick <= baseline.server_tick
                                });

                            if should_force_full {
                                let snapshot = ServerMultiplayerMessage::StateSnapshot {
                                    world_id: snapshot_world_id.clone(),
                                    server_tick,
                                    players: filtered_players,
                                };
                                if send_ws_message(&mut socket, &snapshot).await.is_err() {
                                    break;
                                }

                                snapshot_baseline = Some(SessionSnapshotBaseline {
                                    server_tick,
                                    players_by_id: next_players_by_id,
                                    delta_frames_since_full: 0,
                                });
                            } else {
                                let baseline = snapshot_baseline
                                    .as_ref()
                                    .expect("baseline should be present when not forcing full");
                                let delta = build_snapshot_delta(
                                    snapshot_world_id.as_str(),
                                    server_tick,
                                    &filtered_players,
                                    baseline.server_tick,
                                    &baseline.players_by_id,
                                );
                                let delta_message = ServerMultiplayerMessage::StateSnapshotDelta {
                                    world_id: delta.world_id,
                                    server_tick: delta.server_tick,
                                    baseline_server_tick: delta.baseline_server_tick,
                                    upsert_players: delta.upsert_players,
                                    removed_player_ids: delta.removed_player_ids,
                                };
                                if send_ws_message(&mut socket, &delta_message).await.is_err() {
                                    break;
                                }

                                snapshot_baseline = Some(SessionSnapshotBaseline {
                                    server_tick,
                                    players_by_id: next_players_by_id,
                                    delta_frames_since_full: baseline
                                        .delta_frames_since_full
                                        .saturating_add(1),
                                });
                            }

                            match send_world_entity_snapshot_for_session(
                                &state,
                                &mut socket,
                                snapshot_world_id.as_str(),
                                server_tick,
                                observer_position,
                                session_world_context.as_ref(),
                                world_entity_baseline.take(),
                            )
                            .await
                            {
                                Ok(next_baseline) => {
                                    world_entity_baseline = next_baseline;
                                }
                                Err(()) => {
                                    break;
                                }
                            }
                        }
                    }
                    Ok(ServerMultiplayerMessage::WorldCommitApplied {
                        world_id: commit_world_id,
                        commit_id,
                        saved_to,
                        user_id: target_user_id,
                        world_context: commit_world_context,
                        world,
                    }) => {
                        let should_deliver = should_deliver_world_commit_for_session(
                            world_id.as_str(),
                            session_user_id.as_str(),
                            session_world_context.as_ref(),
                            commit_world_id.as_str(),
                            &saved_to,
                            target_user_id.as_deref(),
                            commit_world_context.as_ref(),
                        );

                        if !should_deliver {
                            continue;
                        }

                        let message = ServerMultiplayerMessage::WorldCommitApplied {
                            world_id: commit_world_id,
                            commit_id,
                            saved_to,
                            user_id: target_user_id,
                            world_context: commit_world_context,
                            world,
                        };
                        if send_ws_message(&mut socket, &message).await.is_err() {
                            break;
                        }
                    }
                    Ok(message) => {
                        if send_ws_message(&mut socket, &message).await.is_err() {
                            break;
                        }
                    }
                    Err(RecvError::Lagged(_)) => continue,
                    Err(RecvError::Closed) => break,
                }
            }
        }
    }

    state.multiplayer.remove_player(&player.player_id).await;
}

async fn handle_client_message(
    state: &AppState,
    socket: &mut WebSocket,
    player_id: &str,
    world_id: &str,
    text: &str,
) -> Result<Option<SessionMessageUpdate>, ()> {
    let parsed = serde_json::from_str::<ClientMultiplayerMessage>(text);
    let message = match parsed {
        Ok(value) => value,
        Err(error) => {
            let server_error = ServerMultiplayerMessage::Error {
                message: format!("invalid websocket payload: {}", error),
            };
            send_ws_message(socket, &server_error).await?;
            return Ok(None);
        }
    };

    match message {
        ClientMultiplayerMessage::Hello {
            user_id,
            world_id: requested_world_id,
            avatar_id,
            world_context,
        } => {
            if let Some(requested_world) = requested_world_id {
                if requested_world != world_id {
                    let warning = ServerMultiplayerMessage::Error {
                        message: format!(
                            "world switch is not supported in current session (requested='{}', active='{}')",
                            requested_world, world_id
                        ),
                    };
                    send_ws_message(socket, &warning).await?;
                }
            }

            let normalized_user_id = user_id
                .as_deref()
                .map(str::trim)
                .map(str::to_string)
                .filter(|value| !value.is_empty());
            state
                .multiplayer
                .set_player_identity(player_id, normalized_user_id.clone())
                .await;
            state
                .multiplayer
                .set_player_avatar(player_id, avatar_id)
                .await;
            let normalized_world_context = normalize_world_context(world_id, world_context);
            state
                .multiplayer
                .set_player_context(player_id, normalized_world_context.clone())
                .await;
            return Ok(Some(SessionMessageUpdate {
                updated_user_id: normalized_user_id,
                updated_world_context: normalized_world_context,
            }));
        }
        ClientMultiplayerMessage::PlayerUpdate {
            position_3d,
            yaw,
            pitch,
            client_tick,
            avatar_id,
            world_context,
        } => {
            let normalized_world_context = normalize_world_context(world_id, world_context);
            let update_result = state
                .multiplayer
                .update_player_with_world_context(
                    player_id,
                    position_3d,
                    yaw,
                    pitch,
                    client_tick,
                    avatar_id,
                    normalized_world_context.clone(),
                )
                .await;

            if matches!(update_result, PlayerInputEnqueueResult::PlayerMissing) {
                let warning = ServerMultiplayerMessage::Error {
                    message: "player session no longer exists".to_string(),
                };
                send_ws_message(socket, &warning).await?;
            }
            return Ok(Some(SessionMessageUpdate {
                updated_user_id: None,
                updated_world_context: normalized_world_context,
            }));
        }
        ClientMultiplayerMessage::Ping => {
            send_ws_message(socket, &ServerMultiplayerMessage::Pong).await?;
        }
    }

    Ok(None)
}

async fn send_ws_message(
    socket: &mut WebSocket,
    message: &ServerMultiplayerMessage,
) -> Result<(), ()> {
    let payload = serde_json::to_string(message).map_err(|_| ())?;
    socket
        .send(Message::Text(payload.into()))
        .await
        .map_err(|_| ())
}

async fn send_world_entity_snapshot_for_session(
    state: &AppState,
    socket: &mut WebSocket,
    world_id: &str,
    server_tick: u64,
    observer_position: [f32; 3],
    session_world_context: Option<&MultiplayerWorldContext>,
    baseline: Option<SessionWorldEntityBaseline>,
) -> Result<Option<SessionWorldEntityBaseline>, ()> {
    let world = {
        let repository = state.repository.read().await;
        repository.get_world_snapshot(world_id, None)
    };

    let Some(world) = world else {
        return Ok(None);
    };

    let context_entities = collect_context_entities(&world, session_world_context);
    let filtered_entities = filter_context_entities_for_observer(
        &context_entities,
        observer_position,
        AoiPolicy::default(),
    );
    let next_entities_by_id = world_entities_by_id(&filtered_entities);

    let should_force_full = baseline.as_ref().map_or(true, |value| {
        value.delta_frames_since_full >= SNAPSHOT_DELTA_REBASE_INTERVAL
            || server_tick <= value.server_tick
    });

    if should_force_full {
        let snapshot = ServerMultiplayerMessage::WorldEntitySnapshot {
            world_id: world_id.to_string(),
            server_tick,
            entities: filtered_entities,
        };
        send_ws_message(socket, &snapshot).await?;

        return Ok(Some(SessionWorldEntityBaseline {
            server_tick,
            entities_by_id: next_entities_by_id,
            delta_frames_since_full: 0,
        }));
    }

    let previous = baseline.expect("baseline should exist for world entity delta");
    let delta = build_world_entity_snapshot_delta(
        world_id,
        server_tick,
        &filtered_entities,
        previous.server_tick,
        &previous.entities_by_id,
    );
    let delta_message = ServerMultiplayerMessage::WorldEntitySnapshotDelta {
        world_id: delta.world_id,
        server_tick: delta.server_tick,
        baseline_server_tick: delta.baseline_server_tick,
        upsert_entities: delta.upsert_entities,
        removed_entity_ids: delta.removed_entity_ids,
    };
    send_ws_message(socket, &delta_message).await?;

    Ok(Some(SessionWorldEntityBaseline {
        server_tick,
        entities_by_id: next_entities_by_id,
        delta_frames_since_full: previous.delta_frames_since_full.saturating_add(1),
    }))
}

#[cfg(test)]
mod tests {
    use super::{
        should_deliver_master_world_commit_for_context, should_deliver_world_commit_for_session,
        visible_to_others_from_mode,
    };
    use crate::multiplayer::MultiplayerWorldContext;
    use crate::protocol::CommitTarget;

    #[test]
    fn master_world_commit_delivery_respects_focus_context() {
        assert!(should_deliver_master_world_commit_for_context(None, None));

        let context_a = MultiplayerWorldContext {
            root_world_id: "world-main".to_string(),
            instance_path: vec!["sphere-template-root-1".to_string()],
        };
        let context_a_copy = MultiplayerWorldContext {
            root_world_id: "world-main".to_string(),
            instance_path: vec!["sphere-template-root-1".to_string()],
        };
        let context_b = MultiplayerWorldContext {
            root_world_id: "world-main".to_string(),
            instance_path: vec!["sphere-template-root-2".to_string()],
        };
        assert!(should_deliver_master_world_commit_for_context(
            Some(&context_a),
            Some(&context_a_copy),
        ));
        assert!(!should_deliver_master_world_commit_for_context(
            Some(&context_a),
            Some(&context_b),
        ));
        assert!(!should_deliver_master_world_commit_for_context(
            None,
            Some(&context_a)
        ));
        assert!(!should_deliver_master_world_commit_for_context(
            Some(&context_a),
            None
        ));
    }

    #[test]
    fn visibility_mode_hidden_maps_to_not_visible() {
        assert!(visible_to_others_from_mode(None));
        assert!(visible_to_others_from_mode(Some("visible")));
        assert!(!visible_to_others_from_mode(Some("hidden")));
        assert!(!visible_to_others_from_mode(Some("  hidden  ")));
        assert!(visible_to_others_from_mode(Some("unknown")));
    }

    #[test]
    fn world_commit_delivery_allows_cross_world_master_sync() {
        assert!(should_deliver_world_commit_for_session(
            "world-main",
            "user-a",
            None,
            "world-template-2",
            &CommitTarget::Master,
            None,
            None,
        ));
    }

    #[test]
    fn world_commit_delivery_keeps_context_filter_for_same_world_master() {
        let session_context = MultiplayerWorldContext {
            root_world_id: "world-main".to_string(),
            instance_path: vec!["sphere-template-root-1".to_string()],
        };
        let different_commit_context = MultiplayerWorldContext {
            root_world_id: "world-main".to_string(),
            instance_path: vec!["sphere-template-root-2".to_string()],
        };

        assert!(!should_deliver_world_commit_for_session(
            "world-main",
            "user-a",
            Some(&session_context),
            "world-main",
            &CommitTarget::Master,
            None,
            Some(&different_commit_context),
        ));
    }

    #[test]
    fn world_commit_delivery_limits_user_branch_updates_to_same_user_and_world() {
        assert!(should_deliver_world_commit_for_session(
            "world-main",
            "user-a",
            None,
            "world-main",
            &CommitTarget::User,
            Some("user-a"),
            None,
        ));
        assert!(!should_deliver_world_commit_for_session(
            "world-main",
            "user-a",
            None,
            "world-template-2",
            &CommitTarget::User,
            Some("user-a"),
            None,
        ));
        assert!(!should_deliver_world_commit_for_session(
            "world-main",
            "user-a",
            None,
            "world-main",
            &CommitTarget::User,
            Some("user-b"),
            None,
        ));
    }
}
