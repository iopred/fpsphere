import { describe, expect, it } from "vitest";
import {
  applyMultiplayerSnapshotDelta,
  type MultiplayerSnapshot,
} from "../src/game/multiplayerClient";

function baselineSnapshot(): MultiplayerSnapshot {
  return {
    world_id: "world-main",
    server_tick: 10,
    players: [
      {
        player_id: "player-a",
        position_3d: [0, 0, 0],
        yaw: 0,
        pitch: 0,
        avatar_id: "duck",
        last_processed_input_tick: 1,
      },
      {
        player_id: "player-b",
        position_3d: [1, 0, 0],
        yaw: 0,
        pitch: 0,
        avatar_id: "human",
        last_processed_input_tick: 2,
      },
    ],
  };
}

describe("applyMultiplayerSnapshotDelta", () => {
  it("returns null when baseline is missing or mismatched", () => {
    const delta = {
      world_id: "world-main",
      server_tick: 11,
      baseline_server_tick: 10,
      upsert_players: [],
      removed_player_ids: [],
    };

    expect(applyMultiplayerSnapshotDelta(null, delta)).toBeNull();
    expect(
      applyMultiplayerSnapshotDelta(
        {
          world_id: "world-other",
          server_tick: 10,
          players: [],
        },
        delta,
      ),
    ).toBeNull();
    expect(
      applyMultiplayerSnapshotDelta(
        {
          world_id: "world-main",
          server_tick: 9,
          players: [],
        },
        delta,
      ),
    ).toBeNull();
  });

  it("applies removals and upserts and keeps deterministic id ordering", () => {
    const merged = applyMultiplayerSnapshotDelta(baselineSnapshot(), {
      world_id: "world-main",
      server_tick: 11,
      baseline_server_tick: 10,
      upsert_players: [
        {
          player_id: "player-c",
          position_3d: [2, 0, 0],
          yaw: 0.1,
          pitch: 0,
          avatar_id: "duck",
          last_processed_input_tick: 1,
        },
        {
          player_id: "player-a",
          position_3d: [3, 0, 0],
          yaw: 0.2,
          pitch: 0,
          avatar_id: "human",
          last_processed_input_tick: 3,
        },
      ],
      removed_player_ids: ["player-b"],
    });

    expect(merged).not.toBeNull();
    expect(merged?.server_tick).toBe(11);
    expect(merged?.players.map((player) => player.player_id)).toEqual([
      "player-a",
      "player-c",
    ]);
    expect(merged?.players[0].position_3d).toEqual([3, 0, 0]);
    expect(merged?.players[0].avatar_id).toBe("human");
  });

  it("supports deterministic chained deltas", () => {
    const first = applyMultiplayerSnapshotDelta(baselineSnapshot(), {
      world_id: "world-main",
      server_tick: 11,
      baseline_server_tick: 10,
      upsert_players: [
        {
          player_id: "player-a",
          position_3d: [4, 0, 0],
          yaw: 0.3,
          pitch: 0,
          avatar_id: "duck",
          last_processed_input_tick: 4,
        },
      ],
      removed_player_ids: [],
    });
    expect(first).not.toBeNull();

    const second = applyMultiplayerSnapshotDelta(first, {
      world_id: "world-main",
      server_tick: 12,
      baseline_server_tick: 11,
      upsert_players: [],
      removed_player_ids: ["player-b"],
    });
    const repeatedSecond = applyMultiplayerSnapshotDelta(first, {
      world_id: "world-main",
      server_tick: 12,
      baseline_server_tick: 11,
      upsert_players: [],
      removed_player_ids: ["player-b"],
    });

    expect(second).toEqual(repeatedSecond);
    expect(second?.players.map((player) => player.player_id)).toEqual(["player-a"]);
  });
});
