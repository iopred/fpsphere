# ADR-0001: Unified World Instance Model (Worlds == Templates)

- Status: Proposed
- Date: 2026-03-05
- Owners: FPSphere core runtime/backend
- Related plan: [PLAN.md](../PLAN.md) section 13.4 (`E6-UNIFIED-WORLD-INSTANCES`)

## Context

Current template behavior is implemented as interleaved sphere data inside a single world payload, with client-side expansion and backend compatibility compaction.

Observed issues:
- world data and template-definition data are interleaved in a flat structure.
- rendering/template expansion requires scanning the entire entity list.
- edit semantics are harder to reason about because "template" and "world" are treated as separate concepts.
- AOI for world-entity streams is difficult to scope cleanly by editing context.

## Problem Statement

We need a model where nested content is represented directly as world references, so:
- templates and worlds are unified as the same data type.
- parent worlds render child worlds through explicit instances.
- editor/multiplayer context boundaries are explicit and stable.
- AOI filtering for world-entity streams can be scoped per world context.

## Decision

Adopt a unified world-instance model:

1. A template is just a world.
2. Parent worlds contain instance references to child worlds.
3. Instance transform data is owned by the parent world.
4. Child world entity data is owned by the child world.
5. Rendering resolves nested worlds by following world-instance references.

Decision addendum (2026-03-05):
- `world_instance` should share the same base shape as `SphereEntity` so spheres and world instances stay compatible.
- World-instance semantics are activated by instance-reference fields (for example, `instance_world_id`) rather than a separate hard entity family.
- This keeps fallback rendering behavior available (for example, recursion-disallowed instances can still render as colored spheres using existing color dimensions).
- World-context identity should be structured as `{ root_world_id, instance_path }`, with `instance_path` as ordered instance IDs.
- Instance mutability defaults to linked/shared child worlds; forked behavior can be added later as an explicit mode.
- Sprint 6 exit priority is verified refactor correctness and full legacy template-path cleanup; AOI performance metrics are tracked but not blocking at this stage.

### Decision Details

#### Data model direction

- Keep a shared sphere-compatible entity shape for both plain spheres and world instances.
- A world instance is identified by instance-reference fields on the shared shape:
  - `instance_world_id` (target child world id)
  - transform parameters (position, scale, yaw/pitch, and future-safe fields)
  - instance metadata/tags
- Parent world deletes remove instance references only.
- Child world data lifecycle is independent from instance lifecycle.
- When recursion/cycle rendering is disallowed, fallback sphere rendering remains available using existing dimensions/tags (including color dimensions).

#### Runtime semantics

- Active editor context is a world context id/path, not a template-root sphere id.
- Enter/exit nested editing transitions world context, preserving local selection state per context where useful.
- Render expansion uses world-instance cache/lookup rather than interleaved template-definition scans.

#### Multiplayer/AOI semantics

- Focus context keys become structured world context:
  - `root_world_id`
  - `instance_path` (ordered instance IDs)
- World-entity stream filtering first partitions by world context, then applies spatial AOI policy.
- Template/world editors should not receive unrelated entity updates from other contexts.

## Non-Goals

- This ADR does not define final UI layout for world-context breadcrumbs.
- This ADR does not introduce authz/admin endpoint changes.
- This ADR does not redesign base sphere physics or movement semantics.

## Compatibility Strategy

- Keep legacy read compatibility during migration.
- Add adapter from legacy `world_template`/`world_scale` conventions to v2 world-instance runtime shape.
- Maintain reversible rollout until parity and AOI acceptance gates pass.

## Migration Plan (High Level)

1. Phase 0: finalize contract + safeguards (cycle detection, depth limits).
2. Phase 1: backend dual-read support with legacy adapter.
3. Phase 2: frontend/editor v2 runtime path behind feature flag.
4. Phase 3: multiplayer/AOI world-entity stream cutover to world-context ids.
5. Phase 4: remove legacy template compaction/instancing paths.

## Rollout and Flags

- Primary feature flag: `WORLD_INSTANCE_MODEL_V2` (backend + frontend).
- Suggested rollout order:
  - dev opt-in
  - parity testing scenes
  - v2 default in dev
  - legacy fallback removed after signoff

## Testing and Observability

### Required automated coverage

- datastore migration and round-trip tests (legacy + v2).
- cycle/depth validation tests for nested world resolution.
- render parity tests between legacy and v2 for known scenes.
- editor semantics tests for nested context operations.
- multiplayer/AOI tests for world-context isolation and fanout reduction.

### Required metrics

- world-entity payload size per observer.
- entities delivered per observer tick.
- update latency budget under nested editing scenarios.
- parity failures between legacy and v2 render outputs.

Metric policy for Sprint 6:
- Metrics are required for observability and regression detection.
- Metrics are not blocking exit gates for Sprint 6 while correctness/migration cleanup is the primary objective.

## Risks and Mitigations

1. Risk: cycle/recursive world references cause runaway expansion.
   - Mitigation: hard depth cap + visited-set cycle detection + explicit validation errors.
2. Risk: migration drift between legacy and v2 semantics.
   - Mitigation: dual-read parity tests + staged rollout + reversible fallback until signoff.
3. Risk: context bugs in multiplayer filtering.
   - Mitigation: world-context ids/paths as first-class protocol fields + targeted integration tests.

## Resolved Questions (2026-03-05)

1. Canonical serialized shape:
   - Use a shared sphere-compatible shape with instance-reference fields (no separate hard split required).
2. World-context encoding:
   - Use structured context `{ root_world_id, instance_path }`.
3. Child-world mutability default:
   - Use linked/shared mutability by default; add optional fork behavior later.
4. Sprint 6 signoff thresholds:
   - Prioritize correctness + migration + full legacy cleanup after verification.
   - Track AOI metrics during rollout, but do not block Sprint 6 completion on fixed numeric thresholds.

## Remaining Open Questions

1. Exact field names/types for shared `world_instance` references in shared types and protocol docs.
2. Whether `instance_path` should be transmitted as raw array fields only, or also include a canonical derived key string.

## Exit Criteria

- v2 world-instance path is primary in runtime/backend.
- legacy template compaction/instancing paths removed.
- migration tests and rollback documentation complete.
- AOI world-entity stream acceptance thresholds met.
