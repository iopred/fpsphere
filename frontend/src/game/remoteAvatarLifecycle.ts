import type { RemotePlayerState } from "./multiplayerClient";

export interface RemoteAvatarSnapshotPlan {
  upsertPlayers: RemotePlayerState[];
  removePlayerIds: string[];
}

export function planRemoteAvatarSnapshot(
  snapshotPlayers: readonly RemotePlayerState[],
  localPlayerId: string | null,
  existingPlayerIds: Iterable<string>,
): RemoteAvatarSnapshotPlan {
  const nextPlayersById = new Map<string, RemotePlayerState>();
  for (const player of snapshotPlayers) {
    if (player.player_id === localPlayerId) {
      continue;
    }
    nextPlayersById.set(player.player_id, player);
  }

  const nextIds = new Set(nextPlayersById.keys());
  const removePlayerIds: string[] = [];
  for (const playerId of planRemoteAvatarWorldSwitch(existingPlayerIds)) {
    if (nextIds.has(playerId)) {
      continue;
    }
    removePlayerIds.push(playerId);
  }

  return {
    upsertPlayers: [...nextPlayersById.values()],
    removePlayerIds,
  };
}

export function planRemoteAvatarWorldSwitch(
  existingPlayerIds: Iterable<string>,
): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const playerId of existingPlayerIds) {
    if (seen.has(playerId)) {
      continue;
    }
    seen.add(playerId);
    ids.push(playerId);
  }
  return ids;
}
