mod multiplayer;
mod protocol;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use axum::{Json, Router};
use multiplayer::{
    ClientMultiplayerMessage, MultiplayerHub, PlayerInputEnqueueResult, ServerMultiplayerMessage,
};
use protocol::{
    example_world_snapshot, CommitFailure, CommitRequest, CommitResponse, CommitTarget,
    WorldMutationFailure, WorldRepository, WorldSnapshot,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::RwLock;

#[derive(Clone)]
struct AppState {
    repository: Arc<RwLock<WorldRepository>>,
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
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    user_id: Option<String>,
    world_id: Option<String>,
}

#[derive(Debug, Serialize)]
struct CommitErrorResponse {
    status: &'static str,
    message: String,
    validation_errors: Vec<String>,
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

#[tokio::main]
async fn main() {
    let _ = dotenvy::from_filename(".env");

    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "fpsphere_backend=debug,tower_http=debug".to_string()),
        )
        .init();

    let repository = WorldRepository::new(example_world_snapshot());
    let multiplayer = MultiplayerHub::new();

    let app_state = AppState {
        repository: Arc::new(RwLock::new(repository)),
        multiplayer,
    };

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
        .with_state(app_state);

    let bind_address = std::env::var("BIND_ADDR")
        .unwrap_or_else(|_| "127.0.0.1:4000".to_string())
        .parse::<SocketAddr>()
        .expect("BIND_ADDR must be a valid socket address, e.g. 127.0.0.1:4000");
    tracing::info!("backend listening on {}", bind_address);

    let listener = tokio::net::TcpListener::bind(bind_address)
        .await
        .expect("bind backend listener");

    axum::serve(listener, app)
        .await
        .expect("start backend server");
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
    let response = {
        let mut repository = state.repository.write().await;
        repository.create_world(&request.world_id)
    };

    match response {
        Ok(world) => Ok((
            StatusCode::CREATED,
            Json(WorldMutationResponse {
                world_id: world.world_id,
            }),
        )),
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
    let repository = state.repository.read().await;
    let snapshot = repository.get_world_snapshot(&world_id, query.user_id.as_deref());

    match snapshot {
        Some(world) => Ok(Json(world)),
        None => Err(StatusCode::NOT_FOUND),
    }
}

async fn commit_world(
    Path(world_id): Path<String>,
    State(state): State<AppState>,
    Json(request): Json<CommitRequest>,
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

    let request_user_id = request.user_id.clone();
    let response = {
        let mut repository = state.repository.write().await;
        repository.commit(&world_id, request)
    };

    match response {
        Ok(commit_response) => {
            let saved_to = commit_response.saved_to.clone();
            let user_scope = match &saved_to {
                CommitTarget::Master => None,
                CommitTarget::User => Some(request_user_id),
            };
            state.multiplayer.broadcast_world_commit(
                world_id.clone(),
                commit_response.commit_id.clone(),
                saved_to,
                user_scope,
                commit_response.world.clone(),
            );

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
        Ok(()) => Ok(StatusCode::NO_CONTENT),
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

    ws.on_upgrade(move |socket| handle_ws_connection(socket, state, user_id, world_id))
}

async fn handle_ws_connection(
    mut socket: WebSocket,
    state: AppState,
    user_id: String,
    world_id: String,
) {
    let mut rx = state.multiplayer.subscribe();
    let mut session_user_id = user_id;
    let player = state
        .multiplayer
        .add_player(session_user_id.clone(), world_id.clone())
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
                                    Ok(Some(updated_user_id)) => {
                                        session_user_id = updated_user_id;
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
                            let snapshot = ServerMultiplayerMessage::StateSnapshot {
                                world_id: snapshot_world_id,
                                server_tick,
                                players,
                            };
                            if send_ws_message(&mut socket, &snapshot).await.is_err() {
                                break;
                            }
                        }
                    }
                    Ok(ServerMultiplayerMessage::WorldCommitApplied { world_id: commit_world_id, commit_id, saved_to, user_id: target_user_id, world }) => {
                        if commit_world_id != world_id {
                            continue;
                        }

                        let should_deliver = match saved_to {
                            CommitTarget::Master => true,
                            CommitTarget::User => {
                                target_user_id
                                    .as_deref()
                                    .map(|value| value == session_user_id.as_str())
                                    .unwrap_or(false)
                            }
                        };

                        if !should_deliver {
                            continue;
                        }

                        let message = ServerMultiplayerMessage::WorldCommitApplied {
                            world_id: commit_world_id,
                            commit_id,
                            saved_to,
                            user_id: target_user_id,
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
) -> Result<Option<String>, ()> {
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
            return Ok(normalized_user_id);
        }
        ClientMultiplayerMessage::PlayerUpdate {
            position_3d,
            yaw,
            pitch,
            client_tick,
        } => {
            let update_result = state
                .multiplayer
                .update_player(player_id, position_3d, yaw, pitch, client_tick)
                .await;

            if matches!(update_result, PlayerInputEnqueueResult::PlayerMissing) {
                let warning = ServerMultiplayerMessage::Error {
                    message: "player session no longer exists".to_string(),
                };
                send_ws_message(socket, &warning).await?;
            }
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
