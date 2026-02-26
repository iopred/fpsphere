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

### Backend

1. Start API service:
   - `cd backend && cargo run`
2. Health check:
   - `http://127.0.0.1:4000/healthz`
3. Example world snapshot:
   - `http://127.0.0.1:4000/api/v1/world/world-main`
4. Commit endpoint:
   - `POST http://127.0.0.1:4000/api/v1/world/world-main/commit`

## Current milestone status

- M0 bootstrap in progress:
  - shared schema package
  - frontend app shell
  - backend service stub
- M1 local playable slice started:
  - FPS controls
  - sphere collisions
  - overlay toggle for `money` dimension
