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
- `GET /api/v1/world/:world_id?user_id=<id>`
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
      "time_window": { "start_tick": 0, "end_tick": null },
      "tags": ["world"]
    }
  ]
}
```

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

## WebSocket multiplayer messages

Client -> server:
- `hello`:
```json
{ "type": "hello", "user_id": "user-123", "world_id": "world-main" }
```
- `player_update`:
```json
{
  "type": "player_update",
  "position_3d": [1.0, 2.0, 3.0],
  "yaw": 0.2,
  "pitch": -0.1,
  "client_tick": 42
}
```
  - `client_tick` is the client's monotonically increasing input sequence.

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
      "last_processed_input_tick": 17
    }
  ]
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
  "world": {
    "world_id": "world-main",
    "tick": 12,
    "entities": []
  }
}
```

Delivery semantics:
- `saved_to = master`: delivered to all clients connected to the same `world_id`.
- `saved_to = user`: delivered only to connections for that same `user_id` and `world_id`.

## Contract alignment

- Frontend and backend use equivalent sphere entity fields.
- Naming differences are currently language-style only (`camelCase` in TS, `snake_case` in Rust JSON).
- Next step: unify through generated schema artifacts.
