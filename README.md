# FPSphere

Initial implementation scaffold for:
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
   - Editor-created spheres currently default to `world_template = 1` and `world_scale = 1`.
8. Template selector HUD:
   - Top-right HUD lets you pick the template id used by `C` create in editor mode.
   - The same HUD can change `world_template` on the currently selected sphere.
9. Editor transform controls:
   - Mouse wheel resizes the selected sphere radius.
   - Hold right mouse button to drag the selected sphere along your view direction.

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
5. Commit endpoint:
   - `POST http://127.0.0.1:4000/api/v1/world/world-main/commit`
6. Multiplayer endpoint:
   - `ws://127.0.0.1:4000/ws?user_id=<id>&world_id=world-main`

## Current milestone status

- M0 bootstrap in progress:
  - shared schema package
  - frontend app shell
  - backend service stub
- M1 local playable slice started:
  - FPS controls
  - sphere collisions
  - overlay toggle for `money` dimension
