mod protocol;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use protocol::{example_world_snapshot, WorldSnapshot};
use serde::Serialize;
use std::net::SocketAddr;
use std::sync::Arc;

#[derive(Clone)]
struct AppState {
    world: Arc<WorldSnapshot>,
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    service: &'static str,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG")
                .unwrap_or_else(|_| "fpsphere_backend=debug,tower_http=debug".to_string()),
        )
        .init();

    let app_state = AppState {
        world: Arc::new(example_world_snapshot()),
    };

    let app = Router::new()
        .route("/healthz", get(health))
        .route("/api/v1/world/{world_id}", get(get_world_snapshot))
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
    State(state): State<AppState>,
) -> Result<Json<WorldSnapshot>, StatusCode> {
    if state.world.world_id != world_id {
        return Err(StatusCode::NOT_FOUND);
    }

    Ok(Json(state.world.as_ref().clone()))
}
