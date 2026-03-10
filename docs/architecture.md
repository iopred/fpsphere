# Architecture Baseline

## Components

1. `frontend` (TypeScript + Three.js)
   - render loop
   - local player controller
   - local sphere collision simulation
   - dimensional overlay rendering
2. `packages/shared-types` (TypeScript)
   - entity and contract types
   - runtime parsing/validation helpers
3. `backend` (Rust)
   - health/readiness endpoints
   - world snapshot API stub
   - simulation/network scaffolding entrypoint

## Data model contract

Core entity contract: `SphereEntity`
- `id: string`
- `parentId: string | null`
- `radius: number`
- `position3d: [number, number, number]`
- `dimensions: Record<string, number>`
- `timeWindow: { start: number; end: number | null }`
- `tags: string[]`

Dimension conventions currently used:
- `money`: overlay scalar for the blue SDF-style visualization.
- `r`, `g`, `b`: optional per-sphere color channels used for tint/visual overrides.

## Tick and simulation semantics

- Frontend runs fixed simulation ticks at 60 Hz.
- Rendering runs per-frame with interpolation-ready loop structure.
- Backend snapshot format includes `tick` for authoritative sync evolution.
