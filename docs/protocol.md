# Protocol Notes

## Endpoint stubs

- `GET /healthz`
  - response: service status
- `GET /api/v1/world/:world_id`
  - response: `WorldSnapshot`
- `GET /api/v1/world/:world_id?user_id=<id>`
  - response: user branch `WorldSnapshot` if it exists, otherwise master
- `POST /api/v1/world/:world_id/commit`
  - request: `CommitRequest`
  - response: `CommitResponse`

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

## Contract alignment

- Frontend and backend use equivalent sphere entity fields.
- Naming differences are currently language-style only (`camelCase` in TS, `snake_case` in Rust JSON).
- Next step: unify through generated schema artifacts.
