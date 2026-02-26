# Protocol Notes

## Endpoint stubs

- `GET /healthz`
  - response: service status
- `GET /api/v1/world/:world_id`
  - response: `WorldSnapshot`

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

## Contract alignment

- Frontend and backend use equivalent sphere entity fields.
- Naming differences are currently language-style only (`camelCase` in TS, `snake_case` in Rust JSON).
- Next step: unify through generated schema artifacts.
