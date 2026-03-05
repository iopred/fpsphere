# FPSphere

Current implementation includes:
- Web FPS client in TypeScript + Three.js
- Rust backend service
- Shared multidimensional sphere entity contract

## Repository layout

```
/backend
/frontend
/packages/shared-types
/docs
/PLAN.md
```

## Quick start

### Frontend

1. Install workspace dependencies:
   - `npm install`
2. Start the client:
   - `npm run dev:frontend`
3. Open:
   - `http://localhost:5173`
4. World data source:
   - Frontend requests `/api/v1/world/world-main` via Vite proxy to `http://127.0.0.1:4000`.
   - If backend is not running, client falls back to local seed data.
5. Save edits:
   - Press `Cmd+S` (macOS) or `Ctrl+S` (Windows/Linux) to commit local edits.
   - Backend saves to `master` when possible, otherwise falls back to a per-user branch.
6. Multiplayer:
   - Frontend opens a WebSocket connection to `/ws` (proxied to backend).
   - Open multiple browser tabs/windows to see remote players.
7. Subworld instancing:
   - Spheres with `dimensions.world_template` are expanded client-side into scaled sub-spheres.
   - Editor-created spheres default to `world_template = 0` (no template instancing).
8. Template selector HUD:
   - Top-right HUD lets you pick the template id used by `C` create in editor mode.
   - The same HUD can change `world_template` on the currently selected sphere.
9. Level manager HUD:
   - In editor mode, use the Level Select panel to switch levels.
   - Use `Add` to create a new level and `Remove` to delete an existing level.
10. Editor transform controls:
   - Mouse wheel resizes the selected sphere radius (pixel-normalized for trackpads).
   - Hold right mouse button to drag the selected sphere along your view direction.
   - Hold `R` and move mouse to rotate template hosts (`yaw`/`pitch`).
11. Sphere world navigation:
   - `F` in editor mode enters the template world of the selected sphere (`world_template > 0`).
   - `F` with no selected sphere exits back to the parent world.
12. QR marker printer:
   - Open `http://localhost:5173/?mode=qr`.
   - Pick a `world_id`, optional AR world scale multiplier, then print at 100% scale.
13. Mobile AR marker viewer:
   - Open `http://localhost:5173/?mode=ar` on a phone browser (uses native `BarcodeDetector` when available, otherwise JS fallback).
   - Grant camera access and point at the printed marker to anchor the FPSphere world on top of the live camera view.
   - AR mode now renders the same world snapshot/model pipeline as FPS mode and also displays live remote multiplayer players.
   - For phone camera access, run on a secure origin (`https://`) or localhost-equivalent.
   - On iOS browsers (Chrome/Safari WebKit), native `BarcodeDetector` may be missing; the app now falls back to a JS `jsQR` decoder loaded at runtime.
14. Avatar selection in editor mode:
   - In editor mode, use the Template HUD `Avatar` row (`-` / `+`) to choose local multiplayer avatar (`duck` or `human`).
   - Avatar choice is sent as `avatar_id` in the multiplayer handshake (`hello`) and player updates, and appears for remote players in both FPS and AR views.
15. Avatar editor mode:
   - Open `http://localhost:5173/?mode=avatar`.
   - Adjust avatar layout sliders and preview the mesh live.
   - Layout overrides are stored in localStorage and reused by FPS + AR remote avatar rendering.

### Backend

1. Configure backend env:
   - Defaults are in `backend/.env`.
   - For LAN access, set `BIND_ADDR=0.0.0.0:4000`.
2. Start API service:
   - `cd backend && cargo run`
3. Health check:
   - `http://127.0.0.1:4000/healthz`
4. Example world snapshot:
   - `http://127.0.0.1:4000/api/v1/world/world-main`
5. Available worlds:
   - `http://127.0.0.1:4000/api/v1/worlds`
6. Create world:
   - `POST http://127.0.0.1:4000/api/v1/world`
7. Delete world:
   - `DELETE http://127.0.0.1:4000/api/v1/world/<world_id>`
8. Commit endpoint:
   - `POST http://127.0.0.1:4000/api/v1/world/world-main/commit`
9. Multiplayer endpoint:
   - `ws://127.0.0.1:4000/ws?user_id=<id>&world_id=world-main`
10. Backend admin console (stdin commands while `cargo run` is active):
   - `help`: list admin commands.
   - `reset`: reset datastore to seed world and notify clients to reload.
   - `exit` / `quit`: gracefully stop backend server.
11. Persistent datastore:
   - Backend loads/saves world state as JSON.
   - Default path: `backend/data/world-repository.json`.
   - Override path with `WORLD_DATASTORE_PATH=/absolute/or/relative/path.json`.

## Docker deployment

Build and run the full stack (frontend + backend):

1. From repo root:
   - `docker compose up -d --build`
2. Services:
   - Frontend: `http://127.0.0.1:4001`
   - Backend API: `http://127.0.0.1:4000`
3. Stop:
   - `docker compose down`
4. Stop and remove persisted world data volume:
   - `docker compose down -v`

Notes:
- Backend image: `backend/Dockerfile`
- Frontend image: `frontend/Dockerfile`
- Compose stack: `docker-compose.yml`
- Backend data is persisted in Docker volume `fpsphere_data`.

## Caddy reverse proxy (host machine)

If Caddy runs on the host and Docker publishes ports `4001` and `4000`, add a site block like:

```caddyfile
fpsphere.example.com {
  encode zstd gzip

  @api path /api/* /healthz
  reverse_proxy @api 127.0.0.1:4000

  @ws path /ws*
  reverse_proxy @ws 127.0.0.1:4000

  reverse_proxy 127.0.0.1:4001
}
```

Then reload Caddy:
- `sudo caddy reload --config /etc/caddy/Caddyfile`

Reference config file:
- `deploy/Caddyfile.example`

## Current milestone status

- M0 foundations: complete.
- M1 local playable sphere: complete.
  - FPS controls, fixed-step simulation, and sphere collision resolution.
  - Overlay toggle for `money` dimension.
  - In-world editor mode with select/create/delete, drag, radius edit, and template controls.
  - Backend world load/commit integration with save shortcut (`Cmd/Ctrl+S`).
- M2 multiplayer slice: complete.
  - Authoritative server snapshots now include `server_tick` and per-player `last_processed_input_tick`.
  - Client input sequencing + local prediction/reconciliation are active for the local player.
  - Remote players use interpolated smoothing, with `yaw`/`pitch` kept on a mesh-ready render-pose boundary.
  - World commit broadcast/sync to connected clients.
- M3 avatar presence: in progress.
  - Shared avatar render adapter now used by both FPS and AR remote-player paths.
  - Default remote avatar now uses orientation-readable mesh parts (body + head + direction marker).
  - Editor HUD now includes local avatar selection (`duck` / `human`) and publishes `avatar_id` in multiplayer updates.
  - New Avatar Editor app mode (`?mode=avatar`) supports live layout tuning and persisted per-avatar overrides.
- Additional shipped features:
  - Level management (list/create/delete/switch worlds from editor HUD).
  - Template-driven subworld instancing (`world_template`, `world_scale`) with shared template roots.
  - Legacy template descendant compaction in backend snapshots/commits.
  - QR marker print mode and mobile AR marker viewer mode.
  - Simplified payloads:
    - commit success responses now include `commit_id`, `saved_to`, `reason`, and `world`.
    - multiplayer state snapshots include `world_id`, `server_tick`, and per-player `player_id`, `position_3d`, `yaw`, `pitch`, `avatar_id`, `last_processed_input_tick`.
  - Temporal world query contract added for `GET /api/v1/world/:world_id`:
    - accepts optional `tick`, `window_start_tick`, and `window_end_tick` parameters.
    - enforces temporal query validation (`window_end_tick` requires start and must be `>=` start).
    - applies `time_window` filtering for temporal fetches while preserving parent-child consistency.
  - Template placement playback animation:
    - editor-created template host spheres (`world_template > 0`) now play a time-window-driven creation animation.
    - playback reads `time_window.start_tick` and uses a short intro/overshoot/settle scale curve for editor feedback.
  - Deterministic temporal regression coverage:
    - backend tests verify stable temporal snapshot selection across repeated identical queries.
    - frontend tests verify deterministic temporal filtering and playback progression for repeated tick sampling.
  - AOI policy primitives (Sprint 5 groundwork):
    - backend defines deterministic AOI partition/query utilities for players and world entities.
    - default AOI policy includes domain-specific radii/limits and stable distance+id ordering.
  - AOI multiplayer filtering:
    - websocket state snapshots are now filtered per observer by AOI membership instead of full-world player fanout.
    - observer inclusion is guaranteed; tie-break ordering remains deterministic.
  - Backend datastore persistence + admin reset controls:
    - backend now restores world state from disk on startup and persists create/delete/commit mutations.
    - running backend now supports `reset` (seed restore + client reload notice) and `exit` commands via stdin.
  - Delta multiplayer snapshots:
    - server tracks per-connection snapshot baselines and emits `state_snapshot_delta` messages between periodic full snapshots.
    - client reconstructs authoritative full snapshots from deltas, with automatic fallback to next full baseline on mismatch.
  - Template-focused stream suppression:
    - FPS client now publishes `focus_sphere_id` during template edit context (shared template root).
    - player snapshots are now partitioned by focus context, so template editors no longer leak position updates into main world streams.
    - master world commit broadcasts are delivered only to sessions in the same focus context.
  - Backend delete semantics now reject deleting non-leaf spheres (prevents orphaned parent references).
  - Sprint 1 closeout artifact with acceptance evidence: [docs/sprint-1-closeout.md](docs/sprint-1-closeout.md).
  - Sprint 2 closeout artifact with authoritative movement acceptance evidence: [docs/sprint-2-closeout.md](docs/sprint-2-closeout.md).
