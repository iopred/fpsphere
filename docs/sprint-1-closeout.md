# Sprint 1 Closeout

Date: 2026-02-27
Status: Closed

## Scope Delivered

- Playable FPS loop in browser with pointer lock, movement, and jump.
- Sphere collision integration for world traversal.
- Money overlay visualization toggle.
- Editor mode with sphere create/select/deselect/delete.
- Layout-aware keybindings with QWERTY and Dvorak test coverage.
- Backend world snapshot load + commit save flow with master/user fallback.
- Multiplayer WebSocket transport with remote player state sync.
- Subworld instancing (`world_template`, `world_scale`) and template workflows.
- Level manager UI for list/create/delete/switch world levels.
- AR marker mode and QR marker print mode.

## Acceptance Evidence

Automated verification executed at closeout:

1. `npm --workspace frontend run typecheck`
   - Result: pass
2. `npm --workspace frontend run test:frontend`
   - Result: pass (`6` files, `32` tests)
3. `cargo test` (in `backend`)
   - Result: pass (`19` tests)

## Demo Script (M1 Acceptance)

1. Start backend: `cd backend && cargo run`
2. Start frontend: `npm run dev:frontend`
3. Open `http://localhost:5173`
4. Verify movement and jump:
   - Click canvas to lock pointer
   - Move with `WASD`, jump with `Space`
5. Verify overlay:
   - Press `O` to toggle money overlay visualization
6. Verify editor flow:
   - Press `~` to enter editor mode
   - Press `C` to create sphere
   - Press `E` to select looked-at sphere
   - Press `Q` to deselect
   - Press `Z` to delete selected sphere
   - Use mouse wheel to resize selected sphere
   - Hold right mouse button to drag selected sphere
7. Verify save flow:
   - Press `Cmd+S` / `Ctrl+S`
   - Confirm save status updates in HUD
8. Verify multiplayer:
   - Open a second tab to the same world
   - Confirm remote player sphere movement sync
9. Verify level manager:
   - In editor mode, use Level Select to add/select/remove a level

## Remaining Next-Milestone Items

- Authoritative simulation loop for multiplayer.
- Client prediction/reconciliation.
