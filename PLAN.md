# FPSphere Project Plan

## 0. Build Status Tracker

- [x] M0: Foundations
- [x] M1: Local Playable Sphere
- [x] M2: Multiplayer Slice
- [ ] M3: Avatar Presence
- [ ] M4: Temporal Queries and Animation Feedback
- [ ] M5: AOI and Delta Networking
- [x] C1: Rendering app shell
- [x] C2: FPS controller
- [x] C3: Sphere physics integration
- [x] C4: Overlay rendering
- [x] C5: M1 playable assembly
- [x] C6: Editor mode interactions

## 0.1 Sprint Update (Latest)

- [x] Backend admin console commands:
  - `help` for command discovery.
  - `reset` to restore seed world data and broadcast a client reload notice.
  - `exit`/`quit` for graceful backend shutdown.
- [x] Backend persistence:
  - startup restore from JSON datastore when present.
  - commit/create/delete/reset now persist to datastore.
  - datastore path configurable through `WORLD_DATASTORE_PATH`.
- [x] Client reset handling:
  - multiplayer now supports a `server_reset` notice and reloads world data in FPS + AR modes.

## 1. Project Intent

Build a web-based FPS simulation platform where:
- The client is written in TypeScript with Three.js.
- The multiplayer backend is written in Rust.
- World data is represented in a multidimensional spatial-temporal datastore.
- The first three dimensions are rendered geometrically.
- Higher dimensions are optionally visualized through SDF-driven color overlays (for example, a "money" dimension rendered as a blue overlay).

Initial milestone target:
- A local single-player FPS slice inside one parent sphere.
- The parent sphere contains child spheres used as collidable world objects.
- Rigid body simulation supports navigation and collisions against sphere-based structures (ground/building proxies).

## 2. Scope Definition

## In Scope (Milestone 1)
- Browser-based first-person movement (mouse look + WASD + jump).
- A single loaded "world sphere" with nested spheres.
- Sphere-based collision and rigid body stepping.
- Deterministic frame/update loop architecture suitable for future networking.
- In-world editor mode for sphere CRUD + selection:
  - `~`: toggle editor mode on/off.
  - `C` (editor mode): create sphere in front of player and select it.
  - `Q` (editor mode): deselect current sphere.
  - `E` (editor mode): select the sphere under reticle/raycast.
  - `Z` (editor mode): delete selected sphere.
- Keyboard-layout compatibility for editing shortcuts, including Dvorak.
- Datastore schema/API capable of storing:
  - Sphere identity and hierarchy.
  - Core spatial dimensions (x, y, z).
  - Extra dimensions as typed attributes.
  - Time/version metadata.
- Frontend debug visualization of one higher dimension via color overlay.
- Minimal Rust backend service scaffolding and protocol contract (even if game runs local-first).

## Out of Scope (Milestone 1)
- Full internet-scale multiplayer.
- Production matchmaking and account systems.
- Advanced weapon systems/combat balance.
- Full procedural generation pipeline.
- Persistent cloud ops hardening.

## 3. Architecture Baseline

## High-level components
1. Frontend Rendering (TypeScript + Three.js)
2. Frontend Data Runtime (TypeScript datastore/query client + transform to render objects)
3. Backend Core (Rust service + simulation/network contracts)

## Data model concept
- `SphereEntity`
  - `id`, `parent_id`, `radius`
  - `position_3d`: `[x, y, z]`
  - `dimensions`: map of extra dimension values, e.g. `{ money: 0.72 }`
  - `time_window`: `[t_start, t_end]` or version
  - `material/render tags`
- Rendering rule:
  - Geometry from first three dimensions.
  - Overlay shading sampled from selected extra dimension via SDF/color transfer function.

## Simulation model (M1)
- Broad phase: sphere-sphere checks.
- Narrow phase: analytic sphere collision response.
- Player controller: capsule-or-sphere approximation (start with sphere for simplicity).

## 4. Milestones

## [x] M0: Foundations (1-2 weeks)
- Repository layout, build tooling, CI skeleton.
- Shared protocol/types package (schema-first).
- Developer docs and run scripts.

Exit criteria:
- `frontend` app boots to blank scene.
- `backend` Rust service runs health endpoint.
- Shared schema compiles in both environments.

## [x] M1: Local Playable Sphere (2-4 weeks)
- Implement single-sphere world load and nested sphere objects.
- Implement local FPS controller + collisions.
- Implement basic dimensional overlay (money -> blue intensity).
- Implement editor mode with in-world sphere create/select/deselect/delete.
- Implement layout-aware keybinding layer so editor shortcuts work on QWERTY and Dvorak.
- Provide deterministic tick/update loop.

Exit criteria:
- [x] User can move/jump in browser.
- [x] Collisions against nested spheres are stable.
- [x] Toggle overlay mode and observe colorized dimension data.
- [x] User can press `~` to enter/exit editor mode.
- [x] In editor mode:
  - [x] `C` creates a sphere in front of player and auto-selects it.
  - [x] `Q` deselects selected sphere.
  - [x] `E` selects looked-at sphere via raycast.
  - [x] `Z` deletes selected sphere.
- [x] Shortcut behavior is validated for both QWERTY and Dvorak keyboard layouts.
- [x] Scene is sourced from datastore model (not hardcoded mesh-only).

## [x] M2: Multiplayer Slice (3-5 weeks)
- Authoritative Rust simulation loop for multiplayer movement state.
- Client prediction/reconciliation.
- Snapshot/state sync for player movement and world commits.
- Remote interpolation/smoothing with orientation wired for mesh-ready avatars.

Exit criteria:
- [x] Two clients can connect and observe synchronized movement in same sphere space.
- [x] Sprint 2 closeout evidence recorded in [docs/sprint-2-closeout.md](docs/sprint-2-closeout.md).

## [ ] M3: Avatar Presence (next sprint)
- Replace sphere-only remote player rendering with an avatar pipeline.
- Keep avatar pose update boundary independent from avatar mesh implementation.
- Support both desktop FPS and AR remote avatar rendering through the same adapter.

## [ ] M4: Temporal Queries and Animation Feedback
- Activate `time_window` in query/runtime filtering.
- Add timeline-driven animation hooks and deterministic temporal sampling.
- Add template-placement creation playback animation for editor feedback.

## [ ] M5: AOI and Delta Networking
- Add area-of-interest filtering for player and world updates.
- Add delta snapshot transport with full-snapshot fallback.
- Reduce irrelevant update traffic (for example, template editing should not stream unrelated world updates).

## 5. Workstreams (Historical Reference)

The workstreams below capture ownership areas and dependency order used during delivery.

## Workstream A: Backend (Rust)

### [x] A1. Service scaffold and contracts
- Define API/protocol for:
  - world sphere fetch
  - entity snapshot
  - simulation tick input/output envelope
- Add health/readiness endpoints.

Depends on: none  
Delivers: `backend` crate + protocol docs

### [ ] A2. Authoritative sphere simulation core
- Implement simulation state with sphere entities and time step.
- Integrate collision checks and simple response.
- Add deterministic step tests.

Depends on: A1  
Delivers: simulation module + test suite

### [x] A3. State sync transport prototype
- WebSocket transport for snapshots and input messages.
- Sequence IDs and tick IDs for reconciliation.

Depends on: A1, A2  
Delivers: networking module + integration test harness

### [x] A4. Persistence adapter + datastore integration
- Define repository persistence boundary.
- Add file-backed JSON datastore with startup restore and mutation persistence.
- Add backend admin reset flow that restores seed data and notifies clients to reload.

Depends on: A1  
Delivers: datastore integration, persistence flows, and admin reset/reload signaling

## Workstream B: Frontend Data Store Runtime (TypeScript)

### [x] B1. Shared entity schema in TS
- Create strongly typed `SphereEntity`, dimension maps, and version/time metadata.
- Validation/codec layer (runtime-safe parse).

Depends on: M0 setup  
Delivers: `packages/shared-types` or equivalent

### [x] B2. Query + scene graph transform
- Convert datastore entities to scene graph nodes.
- Preserve parent-child sphere relationships.
- Generate render payloads and physics payloads from same source.

Depends on: B1  
Delivers: transform pipeline + tests

### [x] B3. Dimensional overlay pipeline
- Implement dimension selector (e.g., `money`).
- Map dimension scalar to color intensity/gradient.
- Expose overlay uniforms/material params for renderer.

Depends on: B1, B2  
Delivers: overlay module + example presets

### [ ] B4. Temporal/version support
- Add time-window filtering and deterministic snapshot selection.
- Ensure stable frame-to-frame entity identity.

Depends on: B1, B2  
Delivers: temporal query layer + tests

### [x] B5. Edit command model + local mutation pipeline
- Add command schema for `create/select/deselect/delete` editor actions.
- Apply local datastore mutations with stable IDs and parent links.
- Emit change events for renderer/physics resync.

Depends on: B1, B2  
Delivers: edit command + mutation modules with tests

## Workstream C: Frontend Rendering + FPS (TypeScript/Three.js)

### [x] C1. Rendering app shell
- Three.js scene/camera/lighting setup.
- Fixed tick + variable render loop wiring.

Depends on: M0 setup  
Delivers: bootable client app

### [x] C2. FPS controller
- Pointer lock camera + movement/jump.
- Input sampling tied to simulation ticks.

Depends on: C1  
Delivers: player controller module

### [x] C3. Sphere physics integration
- Consume physics payloads from datastore transform.
- Resolve player-to-sphere and sphere-to-sphere collisions (M1 fidelity).

Depends on: C1, C2, B2  
Delivers: local physics integration

### [x] C4. Overlay rendering
- Material/shader path for dimensional color overlay.
- Runtime toggle between base view and selected overlay.

Depends on: C1, B3  
Delivers: overlay rendering controls

### [x] C5. M1 playable assembly
- Wire C2+C3+C4 with test world data.
- Add on-screen debug HUD (tick, collisions, overlay dimension).

Depends on: C2, C3, C4, B2  
Delivers: M1 demo scene

### [x] C6. Editor mode interactions
- Add editor state machine (`play` vs `edit`) and HUD status.
- Add reticle raycast selection for looked-at sphere (`E`).
- Add create-in-front action (`C`) and delete selected action (`Z`).
- Add deselect action (`Q`) and selected-sphere highlighting.
- Route editor shortcuts through layout-aware keybinding service.

Depends on: C2, C3, C5, B5  
Delivers: editable in-world sphere workflow

## 6. Cross-Workstream Contracts

## Contract 1: Entity payload
- Backend and frontend share `SphereEntity` contract.
- IDs are stable UUID/string; parent links required.

## Contract 2: Tick semantics
- Simulation tick rate fixed (proposed: 60Hz).
- Client input packets reference tick ID.

## Contract 3: Overlay semantics
- Dimension values normalized to `[0,1]` by data runtime before rendering.
- Renderer applies consistent transfer function.

## Contract 4: Editor input semantics
- Editor commands bind to logical keys (`~`, `C`, `Q`, `E`, `Z`) via `KeyboardEvent.key`.
- Input layer provides fallback bindings by `KeyboardEvent.code` for compatibility.
- Acceptance tests must verify shortcut behavior under at least:
  - QWERTY layout
  - Dvorak layout

## 7. Definition of Done (Milestone 1)

Status: achieved in the current prototype build.

- Playable browser FPS in one parent sphere scene.
- Nested spheres block movement via collision.
- World data comes from datastore-style entity representation.
- At least one higher dimension (money) can be toggled as blue overlay.
- In-world editor mode supports:
  - toggle (`~`)
  - create + auto-select (`C`)
  - deselect (`Q`)
  - look-select (`E`)
  - delete selected (`Z`)
- Editing shortcuts are verified on Dvorak as well as QWERTY.
- Basic automated tests exist for:
  - schema validation
  - transform correctness
  - collision determinism
  - editor command behavior (including keyboard layout mapping)

## 8. Suggested Repository Layout

```
/backend                # Rust services/simulation
/frontend               # Three.js TypeScript app
/packages/shared-types  # Cross-language schema/contracts (or generated artifacts)
/docs                   # Architecture + ADRs + protocol notes
/PLAN.md
```

## 9. Risks and Mitigations

1. Risk: Physics instability with naive sphere collision response.
   Mitigation: fixed-step simulation + deterministic tests + conservative restitution defaults.

2. Risk: Datastore abstraction too broad too early.
   Mitigation: keep M1 adapter minimal and versioned; defer distributed persistence complexity.

3. Risk: Renderer and simulation diverge in coordinate/time semantics.
   Mitigation: shared tick contract and single source transform pipeline.

4. Risk: Multiplayer complexity blocks early progress.
   Mitigation: enforce local-first M1 completion before full sync features.

5. Risk: Keyboard layout differences break editor shortcuts.
   Mitigation: use layout-aware keybinding abstraction and test matrix for Dvorak/QWERTY.

## 10. Implementation Sequence (Historical)

Planned sequence used during early milestone execution:

1. Backend track: execute A1 then A4 stubs.
2. Data runtime track: execute B1 then B2 skeleton, then B5 edit mutation pipeline.
3. Rendering track: execute C1 then C2 prototype, then C6 editor interactions.
4. Integration track: wire B2 -> C3 and B3 -> C4, complete C5 demo.
5. QA track: create deterministic test scenarios, including Dvorak/QWERTY shortcut verification.

## 11. First Sprint Checklist

- [x] Create monorepo structure and package manifests.
- [x] Establish shared schema package and ID/time conventions.
- [x] Boot frontend scene and movement prototype.
- [x] Implement minimum sphere world JSON seed.
- [x] Implement local collision loop for player vs world spheres.
- [x] Add overlay toggle for `money` dimension.
- [x] Connect frontend world loading to backend snapshot endpoint.
- [x] Add backend commit endpoint with master/user branch fallback.
- [x] Add frontend save shortcut (`Cmd/Ctrl+S`) for commit submission.
- [x] Add WebSocket multiplayer transport and remote player snapshots.
- [x] Add client-side subworld instancing from sphere dimensions (`world_template`, `world_scale`).
- [x] Add shared template-root workflow and backend compaction of legacy template descendants.
- [x] Implement editor mode toggle with `~`.
- [x] Implement edit shortcuts in editor mode: `C`, `Q`, `E`, `Z`.
- [x] Add editor transform tools (wheel radius + right-mouse drag).
- [x] Add level manager HUD for world list/create/delete/select flows.
- [x] Add layout-aware keybinding tests for Dvorak and QWERTY.
- [x] Add AR marker viewer mode and QR marker print mode.
- [x] Slim server/client payloads for commit success and multiplayer snapshots.
- [x] Enforce backend leaf-only sphere delete semantics to preserve parent references.
- [x] Record M1 demo script and acceptance evidence ([docs/sprint-1-closeout.md](docs/sprint-1-closeout.md)).

## 12. Sprint 2 Plan (M2 Authoritative Movement)

Sprint window: 2026-03-02 to 2026-03-13  
Goal: deliver authoritative multiplayer player movement with client prediction/reconciliation.

### 12.1 Sprint 2 Task IDs

#### S2-A Backend Authority

- [x] `S2-A1` Add fixed server simulation tick loop for connected players (60 Hz target).
- [x] `S2-A2` Introduce authoritative player-state store keyed by `world_id` + `player_id`.
- [x] `S2-A3` Process queued client input by sequence/order (drop stale/duplicate input).
- [x] `S2-A4` Emit authoritative snapshots containing:
  - server tick
  - per-player pose (`position`, `yaw`, `pitch`)
  - last processed input sequence per player (for reconciliation)
- [x] `S2-A5` Add deterministic backend tests for input ordering and state evolution.

#### S2-B Frontend Netcode

- [x] `S2-B1` Add input sequence numbering on outgoing local player updates.
- [x] `S2-B2` Implement client-side local prediction buffer.
- [x] `S2-B3` Implement reconciliation against authoritative snapshots using last-acked input sequence.
- [x] `S2-B4` Add remote-player interpolation/smoothing layer for snapshot deltas.
- [x] `S2-B5` Keep remote orientation wired (`yaw`, `pitch`) with a mesh-ready render adapter boundary.

#### S2-C Protocol + Quality

- [x] `S2-C1` Update protocol docs and shared/frontend backend-facing interfaces for new snapshot envelope.
- [x] `S2-C2` Add integration tests for drift bounds under normal latency simulation.
- [x] `S2-C3` Add regression tests for multiplayer world switching/filtering behavior.
- [x] `S2-C4` Produce Sprint 2 demo checklist and closeout evidence artifact ([docs/sprint-2-closeout.md](docs/sprint-2-closeout.md)).

### 12.2 Sprint 2 Acceptance Tests

Automated acceptance:

1. Backend correctness:
   - `cargo test` passes with new authority/reconciliation test coverage.
   - Includes tests for:
     - monotonic input sequence handling
     - stale/duplicate input rejection
     - deterministic server tick stepping
2. Frontend correctness:
   - `npm --workspace frontend run typecheck` passes.
   - `npm --workspace frontend run test:frontend` passes with new multiplayer netcode tests.
3. Protocol consistency:
   - Snapshot and input contracts documented in `docs/protocol.md`.
   - Frontend client types align with backend payloads.

Manual acceptance:

1. Two-browser authoritative sync:
   - Start backend and frontend.
   - Connect two clients to same world.
   - Move both players simultaneously.
   - Confirm both clients converge to server-authoritative positions (no persistent divergence).
2. Reconciliation behavior:
   - During continuous movement, local motion remains responsive.
   - Reconciliation corrections are visible but controlled (no extreme teleport jitter).
3. Remote smoothing behavior:
   - Remote players appear smooth under normal local dev latency.
   - Orientation updates (`yaw`, `pitch`) remain stable for future mesh-based avatars.

### 12.3 Sprint 2 Definition of Done

- Authoritative server movement loop is active for multiplayer players.
- Client prediction and reconciliation are implemented for local player.
- Remote players are interpolated/smoothed from authoritative snapshots.
- Protocol and tests are updated to prevent drift/regression.
- Demo and evidence are recorded in a Sprint 2 closeout artifact.

## 13. Simplified Forward Roadmap (Active)

This section is the active execution plan. Sections above are retained as delivery history.

### 13.1 Sprint 3 Plan (M3 Avatar Presence)

Sprint window: 2026-03-02 to 2026-03-13  
Goal: ship a mesh-ready avatar pipeline for multiplayer players.

- [x] `S3-A1` Create a shared avatar render adapter used by FPS and AR clients.
- [x] `S3-A2` Replace direct remote-player sphere mesh lifecycle with avatar instances.
- [x] `S3-A3` Render a default orientation-readable avatar mesh (not sphere-only).
- [x] `S3-A4` Add avatar style/config hooks (materials/colors/scale) keyed by player id.
- [x] `S3-A6` Add dedicated avatar editor app mode (`?mode=avatar`) for live layout tuning and persisted overrides.
- [x] `S3-A5` Add regression checks for avatar lifecycle (spawn/update/remove/world-switch).

### 13.2 Sprint 4 Plan (M4 Temporal Queries + Animation Feedback)

Sprint window: 2026-03-16 to 2026-03-27  
Goal: use `time_window` for deterministic temporal querying and editor feedback animation.

- [x] `S4-T1` Define temporal query contract (`tick`, window filtering semantics).
- [x] `S4-T2` Implement runtime/store filtering by `time_window`.
- [x] `S4-T3` Add template-placement creation playback animation driven by `time_window`.
- [x] `S4-T4` Add temporal regression tests for deterministic query/playback behavior.

### 13.3 Sprint 5 Plan (M5 AOI + Delta Networking)

Sprint window: 2026-03-30 to 2026-04-10  
Goal: reduce bandwidth/latency by interest-managed and delta-encoded updates.

- [x] `S5-N1` Define AOI partition/query policy for players and world entities.
- [x] `S5-N2` Filter outbound updates by AOI membership.
- [x] `S5-N3` Add delta snapshot protocol with baseline tracking and fallback full snapshots.
- [x] `S5-N4` Ensure template-focused editing suppresses unrelated large-world update streams.
- [ ] `S5-N5` Add bandwidth/latency acceptance checks for AOI + delta mode.

## 14. Future Sprint Suggestions

### 14.1 Avatar Asset Pipeline + Presets

Goal: make avatar customization easier to author, share, and ship.

- Add import/export flow for avatar JSON from avatar editor mode.
- Add “set as project default” workflow for duck/human/default variants.
- Add curated preset library (duck-like, human-like, stylized variants) with per-preset metadata.
- Add multiplayer-safe avatar fallback behavior when a preset is missing on a client.

### 14.2 Temporal Authoring + Playback UX

Goal: make `time_window` practical for editing workflows and visual feedback.

- Add timeline scrubber in editor for previewing temporal states.
- Add template placement playback controls (speed, repeat, easing profile).
- Add temporal diff/ghost visualization between selected ticks.
- Add deterministic temporal playback integration tests for editor interactions.

### 14.3 AOI Expansion for World-Entity Streams

Goal: extend AOI benefits beyond player snapshots to world-edit data flows.

- Apply AOI partitioning/filtering to world-entity update streams.
- Keep template editing sessions isolated from unrelated large-world updates.
- Add profiling and acceptance thresholds for update fanout, payload size, and tick latency.

### 14.4 Persistence Hardening + Operations

Goal: make datastore behavior safer for longer-running and production-like use.

- Add datastore schema migration/version upgrade path.
- Add periodic backup snapshots and restore tooling.
- Add startup integrity checks with clear fallback/repair behavior.
- Add load/save/reset smoke tests against persisted datasets.

### 14.5 Security + Admin Control Plane (Prerequisite for Remote Admin APIs)

Goal: safely unlock remote admin actions after authentication/authorization exists.

- Add baseline authn/authz model for admin actions.
- Add audit logging for reset, world mutation, and datastore restore actions.
- After auth is in place, add protected admin endpoints (e.g., remote reset/reload).
