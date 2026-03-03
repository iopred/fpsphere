import { describe, expect, it } from "vitest";
import type { RemotePlayerState } from "../src/game/multiplayerClient";
import {
  planRemoteAvatarSnapshot,
  planRemoteAvatarWorldSwitch,
} from "../src/game/remoteAvatarLifecycle";

function remotePlayer(
  playerId: string,
  avatarId: string = "duck",
): RemotePlayerState {
  return {
    player_id: playerId,
    position_3d: [0, 0, 0],
    yaw: 0,
    pitch: 0,
    avatar_id: avatarId,
    last_processed_input_tick: 0,
  };
}

describe("remoteAvatarLifecycle", () => {
  it("spawns remote avatars and excludes local player", () => {
    const plan = planRemoteAvatarSnapshot(
      [remotePlayer("player-local"), remotePlayer("player-remote", "human")],
      "player-local",
      [],
    );

    expect(plan.upsertPlayers).toHaveLength(1);
    expect(plan.upsertPlayers[0].player_id).toBe("player-remote");
    expect(plan.upsertPlayers[0].avatar_id).toBe("human");
    expect(plan.removePlayerIds).toEqual([]);
  });

  it("updates existing remote avatars using latest snapshot value", () => {
    const plan = planRemoteAvatarSnapshot(
      [remotePlayer("player-2", "duck"), remotePlayer("player-2", "human")],
      "player-local",
      ["player-2"],
    );

    expect(plan.upsertPlayers).toHaveLength(1);
    expect(plan.upsertPlayers[0].player_id).toBe("player-2");
    expect(plan.upsertPlayers[0].avatar_id).toBe("human");
    expect(plan.removePlayerIds).toEqual([]);
  });

  it("removes avatars missing from snapshot", () => {
    const plan = planRemoteAvatarSnapshot(
      [remotePlayer("player-2")],
      null,
      ["player-2", "player-3"],
    );

    expect(plan.upsertPlayers.map((item) => item.player_id)).toEqual(["player-2"]);
    expect(plan.removePlayerIds).toEqual(["player-3"]);
  });

  it("clears all known avatars on world switch", () => {
    const removeIds = planRemoteAvatarWorldSwitch([
      "player-2",
      "player-3",
      "player-2",
    ]);

    expect(removeIds).toEqual(["player-2", "player-3"]);
  });
});
