# Protocol Notes

## Endpoint stubs

- `GET /healthz`
  - response: service status
- `GET /api/v1/worlds`
  - response: `{ "world_ids": string[] }`
- `POST /api/v1/world`
  - request: `{ "world_id": "<id>" }`
  - response: `{ "world_id": "<id>" }`
- `GET /api/v1/world/:world_id`
  - response: `WorldSnapshot`
- `DELETE /api/v1/world/:world_id`
  - response: `204 No Content`
- `GET /api/v1/world/:world_id?user_id=<id>&tick=<u64>&window_start_tick=<u64>&window_end_tick=<u64>`
  - response: user branch `WorldSnapshot` if it exists, otherwise master
- `POST /api/v1/world/:world_id/commit`
  - request: `CommitRequest`
  - response: `CommitResponse`
- `GET /ws?user_id=<id>&world_id=<id>` (WebSocket)
  - realtime player presence updates

## WorldSnapshot (Rust API)

```json
{
  "world_id": "world-main",
  "tick": 0,
  "entities": [
    {
      "id": "sphere-world-001",
      "parent_id": null,
      "radius": 60.0,
      "position_3d": [0.0, 0.0, 0.0],
      "dimensions": { "money": 0.0 },
      "instance_world_id": null,
      "time_window": { "start_tick": 0, "end_tick": null },
      "tags": ["world"]
    }
  ]
}
```

## Temporal World Query Contract (S4-T1/S4-T2)

- Query parameters on `GET /api/v1/world/:world_id`:
  - `tick` (optional): target logical tick for deterministic temporal queries.
  - `window_start_tick` (optional): lower bound of temporal window (inclusive).
  - `window_end_tick` (optional): upper bound of temporal window (inclusive).
- Validation rules:
  - `window_end_tick` requires `window_start_tick`.
  - `window_end_tick` must be `>= window_start_tick`.
  - If `tick` and window bounds are both provided, `tick` must fall inside the provided window.
- Current behavior in S4-T1:
  - Request contract and validation are active.
  - Snapshot filtering by `tick` / window is active for `GET /api/v1/world/:world_id`.
  - Filtering keeps parent-child consistency: a child entity is only returned when its parent is also returned.

## AOI Partition/Query Policy (S5-N1)

- Backend AOI policy is now defined for both multiplayer players and world entities.
- Default policy values:
  - `partition_cell_edge = 24.0`
  - `player_radius = 48.0`
  - `world_entity_radius = 36.0`
  - `max_players = 24`
  - `max_world_entities = 96`
- Query semantics:
  - Partition key uses floor quantization per axis: `floor(position / partition_cell_edge)`.
  - Query coverage is computed as a deterministic axis-aligned cube across partition keys.
  - AOI selection is deterministic: sort by squared distance, then by stable id tie-break.
  - Exclusion of observer id is supported for player snapshots.
- Scope in S5-N1:
  - Policy + deterministic selectors are implemented and tested.
  - Outbound multiplayer filtering will consume this policy in S5-N2.

## AOI Snapshot Delivery (S5-N2)

- `state_snapshot.players` is now filtered per recipient connection (not world-global fanout).
- Filtering behavior:
  - observer is always included in its own snapshot when present.
  - nearby players are selected by AOI policy (`player_radius`) using deterministic distance+id ordering.
  - if observer id is unavailable during connect/disconnect churn, delivery fails open (unfiltered) for that snapshot tick.

## CommitRequest (Rust API)

```json
{
  "user_id": "user-123",
  "base_tick": 7,
  "operations": [
    {
      "type": "create",
      "sphere": {
        "id": "sphere-user-001",
        "parent_id": "sphere-world-001",
        "radius": 2.4,
        "position_3d": [2.0, 1.0, -4.0],
        "dimensions": { "money": 0.5 },
        "instance_world_id": "world-main",
        "time_window": { "start_tick": 7, "end_tick": null },
        "tags": ["user-created"]
      }
    },
    {
      "type": "delete",
      "sphere_id": "sphere-old-001"
    },
    {
      "type": "update_dimensions",
      "sphere_id": "sphere-building-001",
      "dimensions": {
        "world_template": 1,
        "world_scale": 0.75
      }
    },
    {
      "type": "update_radius",
      "sphere_id": "sphere-building-001",
      "radius": 6.5
    }
  ]
}
```

## Commit semantics

- Backend first attempts to apply commit to `master`:
  - Requires `base_tick` to match master tick.
  - `move` and `delete` operations require target spheres to exist.
- If master commit cannot be applied, backend attempts to save same operations into the user's branch.
- If user-branch save also fails validation, commit is rejected with `409`.

## Dimension-driven world instancing

- Sphere dimensions may include:
  - `world_template` (numeric template ID)
  - `world_scale` (optional numeric scale multiplier)
- The backend stores these dimensions as normal sphere data.
- The frontend expands template children client-side from these dimensions, so the server does not need to duplicate subworld child entities.
- Transitional model note:
  - `instance_world_id` is available on sphere entities as an explicit nested-world reference field.
  - When `instance_world_id` is missing and legacy `world_template` is present, backend snapshot/commit payloads derive:
    - `instance_world_id = "legacy-template:<template_id>"`.
  - Explicit `instance_world_id` values take precedence over legacy dimension fallback.
  - Legacy dimension-driven instancing remains supported during migration.

## WebSocket multiplayer messages

Client -> server:
- `hello`:
```json
{
  "type": "hello",
  "user_id": "user-123",
  "world_id": "world-main",
  "avatar_id": "human",
  "focus_sphere_id": "sphere-template-root-1",
  "world_context": {
    "root_world_id": "world-main",
    "instance_path": ["sphere-template-root-1"]
  }
}
```
  - `avatar_id` is optional; supported values are `duck` and `human`.
  - When present, the backend applies it immediately for that player session.
  - `focus_sphere_id` is optional; when set, the session is treated as template-focused for update suppression policy.
- `player_update`:
```json
{
  "type": "player_update",
  "position_3d": [1.0, 2.0, 3.0],
  "yaw": 0.2,
  "pitch": -0.1,
  "client_tick": 42,
  "avatar_id": "duck",
  "focus_sphere_id": null,
  "world_context": null
}
```
  - `client_tick` is the client's monotonically increasing input sequence.
  - `avatar_id` is optional; supported values are `duck` and `human`.
  - `focus_sphere_id` is optional; use `null` to clear focus when leaving template edit context.
  - `world_context` is optional and structured as:
    - `root_world_id`: root world id for the active editing context.
    - `instance_path`: ordered instance ids from root to current nested context.
  - Migration behavior:
    - when `world_context` is provided and has a non-empty `instance_path`, server focus partitioning uses it.
    - when missing/empty, server falls back to legacy `focus_sphere_id` behavior.

Server -> client:
- `welcome`:
```json
{
  "type": "welcome",
  "player_id": "player-1",
  "user_id": "user-123",
  "world_id": "world-main"
}
```
- `state_snapshot`:
```json
{
  "type": "state_snapshot",
  "world_id": "world-main",
  "server_tick": 99,
  "players": [
    {
      "player_id": "player-2",
      "position_3d": [3.0, 1.0, 8.0],
      "yaw": 0.0,
      "pitch": 0.0,
      "avatar_id": "human",
      "last_processed_input_tick": 17
    }
  ]
}
```
- `state_snapshot_delta`:
```json
{
  "type": "state_snapshot_delta",
  "world_id": "world-main",
  "server_tick": 100,
  "baseline_server_tick": 99,
  "upsert_players": [
    {
      "player_id": "player-2",
      "position_3d": [3.4, 1.0, 8.3],
      "yaw": 0.1,
      "pitch": 0.0,
      "avatar_id": "human",
      "last_processed_input_tick": 18
    }
  ],
  "removed_player_ids": ["player-8"]
}
```
- `world_commit_applied`:
```json
{
  "type": "world_commit_applied",
  "world_id": "world-main",
  "commit_id": "master-12",
  "saved_to": "master",
  "user_id": null,
  "focus_sphere_id": null,
  "world": {
    "world_id": "world-main",
    "tick": 12,
    "entities": []
  }
}
```

Delivery semantics:
- `state_snapshot` is sent as the baseline frame and periodically re-sent as fallback/rebase.
- `state_snapshot_delta` is sent between baseline frames and applies against `baseline_server_tick`.
- `state_snapshot`/delta streams are partitioned by focus context:
  - no focus (`focus_sphere_id = null`) receives only no-focus players.
  - focused sessions (`focus_sphere_id = <template-root-id>`) receive only players in that same focus context.
- `saved_to = master`: delivered only when session focus context matches commit focus context (`null == null` for main world, or same template root id).
- `saved_to = user`: delivered only to connections for that same `user_id` and `world_id`.

## Contract alignment

- Frontend and backend use equivalent sphere entity fields.
- Naming differences are currently language-style only (`camelCase` in TS, `snake_case` in Rust JSON).
- Next step: unify through generated schema artifacts.
