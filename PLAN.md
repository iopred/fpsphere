# FPSphere Project Plan

## 0. Build Status Tracker

- [x] M0: Foundations
- [ ] M1: Local Playable Sphere
- [ ] M2: Multiplayer Slice
- [ ] M3: Scale and Dimensional Features
- [x] C1: Rendering app shell
- [x] C2: FPS controller
- [ ] C3: Sphere physics integration
- [ ] C4: Overlay rendering
- [ ] C5: M1 playable assembly
- [x] C6: Editor mode interactions

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

## [ ] M1: Local Playable Sphere (2-4 weeks)
- Implement single-sphere world load and nested sphere objects.
- Implement local FPS controller + collisions.
- Implement basic dimensional overlay (money -> blue intensity).
- Implement editor mode with in-world sphere create/select/deselect/delete.
- Implement layout-aware keybinding layer so editor shortcuts work on QWERTY and Dvorak.
- Provide deterministic tick/update loop.

Exit criteria:
- User can move/jump in browser.
- Collisions against nested spheres are stable.
- Toggle overlay mode and observe colorized dimension data.
- User can press `~` to enter/exit editor mode.
- In editor mode:
  - `C` creates a sphere in front of player and auto-selects it.
  - `Q` deselects selected sphere.
  - `E` selects looked-at sphere via raycast.
  - `Z` deletes selected sphere.
- Shortcut behavior is validated for both QWERTY and Dvorak keyboard layouts.
- Scene is sourced from datastore model (not hardcoded mesh-only).

## [ ] M2: Multiplayer Slice (3-5 weeks)
- Authoritative Rust simulation loop for basic movement state.
- Client prediction/reconciliation prototype.
- Snapshot/state sync for sphere entities.

Exit criteria:
- Two clients can connect and observe synchronized movement in same sphere space.

## [ ] M3: Scale and Dimensional Features (ongoing)
- Interest management and partitioning.
- More dimensions and overlay channels.
- Performance tuning and observability.

## 5. Multi-Agent Workstreams

Each workstream below is intentionally parallelizable. Task IDs are dependency-aware so multiple agents can execute concurrently.

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

### [ ] A4. Persistence adapter boundary
- Define datastore adapter traits/interfaces.
- Provide in-memory adapter for M1/M2.

Depends on: A1  
Delivers: adapter interfaces + mock implementation

## Workstream B: Frontend Data Store Runtime (TypeScript)

### [ ] B1. Shared entity schema in TS
- Create strongly typed `SphereEntity`, dimension maps, and version/time metadata.
- Validation/codec layer (runtime-safe parse).

Depends on: M0 setup  
Delivers: `packages/shared-types` or equivalent

### [ ] B2. Query + scene graph transform
- Convert datastore entities to scene graph nodes.
- Preserve parent-child sphere relationships.
- Generate render payloads and physics payloads from same source.

Depends on: B1  
Delivers: transform pipeline + tests

### [ ] B3. Dimensional overlay pipeline
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

### [ ] C3. Sphere physics integration
- Consume physics payloads from datastore transform.
- Resolve player-to-sphere and sphere-to-sphere collisions (M1 fidelity).

Depends on: C1, C2, B2  
Delivers: local physics integration

### [ ] C4. Overlay rendering
- Material/shader path for dimensional color overlay.
- Runtime toggle between base view and selected overlay.

Depends on: C1, B3  
Delivers: overlay rendering controls

### [ ] C5. M1 playable assembly
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

## 10. Agent Execution Plan (Immediate)

Run three agents in parallel after M0 bootstrap:

1. Agent-Backend: execute A1 then A4 stubs.
2. Agent-DataRuntime: execute B1 then B2 skeleton, then B5 edit mutation pipeline.
3. Agent-Rendering: execute C1 then C2 prototype, then C6 editor interactions.

Then merge for integration sprint:

4. Agent-Integration: wire B2 -> C3 and B3 -> C4, complete C5 demo.
5. Agent-QA: create deterministic test scenarios, including Dvorak/QWERTY shortcut verification.

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
- [x] Implement editor mode toggle with `~`.
- [x] Implement edit shortcuts in editor mode: `C`, `Q`, `E`, `Z`.
- [x] Add layout-aware keybinding tests for Dvorak and QWERTY.
- [ ] Record M1 demo script and acceptance evidence.
