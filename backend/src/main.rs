mod protocol;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use protocol::{
    example_world_snapshot, CommitFailure, CommitRequest, CommitResponse, WorldRepository,
    WorldSnapshot,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::RwLock;

#[derive(Clone)]
struct AppState {
    repository: Arc<RwLock<WorldRepository>>,
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

#[derive(Debug, Serialize)]
struct CommitErrorResponse {
    status: &'static str,
    message: String,
    validation_errors: Vec<String>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "fpsphere_backend=debug,tower_http=debug".to_string()),
        )
        .init();

    let repository = WorldRepository::new(example_world_snapshot());

    let app_state = AppState {
        repository: Arc::new(RwLock::new(repository)),
    };

    let app = Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/world/{world_id}", get(get_world_snapshot))
        .route("/api/v1/world/{world_id}/commit", post(commit_world))
        .with_state(app_state);

    let bind_address = SocketAddr::from(([127, 0, 0, 1], 4000));
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

    let mut repository = state.repository.write().await;
    let response = repository.commit(&world_id, request);

    match response {
        Ok(commit_response) => Ok(Json(commit_response)),
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
