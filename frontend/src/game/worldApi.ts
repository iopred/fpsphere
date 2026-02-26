import type { SphereEntity } from "@fpsphere/shared-types";
import { parseSphereEntities } from "@fpsphere/shared-types";
import type { SeedWorld } from "./worldSeed";

interface BackendTimeWindow {
  start_tick: number;
  end_tick: number | null;
}

interface BackendSphereEntity {
  id: string;
  parent_id: string | null;
  radius: number;
  position_3d: [number, number, number];
  dimensions: Record<string, number>;
  time_window: BackendTimeWindow;
  tags: string[];
}

interface BackendWorldSnapshot {
  world_id: string;
  tick: number;
  entities: BackendSphereEntity[];
}

interface BackendCommitResponse {
  commit_id: string;
  saved_to: "master" | "user";
  reason: string | null;
  master_tick: number;
  user_tick: number | null;
  world: BackendWorldSnapshot;
  validation_errors: string[];
}

interface BackendCommitError {
  status: string;
  message: string;
  validation_errors?: string[];
}

interface BackendCommitRequest {
  user_id: string;
  base_tick: number;
  operations: BackendCommitOperation[];
}

type BackendCommitOperation =
  | {
      type: "create";
      sphere: BackendSphereEntity;
    }
  | {
      type: "delete";
      sphere_id: string;
    }
  | {
      type: "move";
      sphere_id: string;
      position_3d: [number, number, number];
    };

export interface LoadedWorld {
  world: SeedWorld;
  tick: number;
}

export type WorldCommitOperation =
  | {
      type: "create";
      sphere: SphereEntity;
    }
  | {
      type: "delete";
      sphereId: string;
    }
  | {
      type: "move";
      sphereId: string;
      position3d: [number, number, number];
    };

export interface CommitWorldParams {
  worldId: string;
  userId: string;
  baseTick: number;
  operations: WorldCommitOperation[];
}

export interface CommitWorldResult {
  commitId: string;
  savedTo: "master" | "user";
  reason: string | null;
  masterTick: number;
  userTick: number | null;
  tick: number;
  world: SeedWorld;
  validationErrors: string[];
}

export class WorldCommitError extends Error {
  readonly validationErrors: string[];

  constructor(message: string, validationErrors: string[] = []) {
    super(message);
    this.name = "WorldCommitError";
    this.validationErrors = validationErrors;
  }
}

function toBackendSphereEntity(entity: SphereEntity): BackendSphereEntity {
  return {
    id: entity.id,
    parent_id: entity.parentId,
    radius: entity.radius,
    position_3d: entity.position3d,
    dimensions: entity.dimensions,
    time_window: {
      start_tick: entity.timeWindow.start,
      end_tick: entity.timeWindow.end,
    },
    tags: entity.tags,
  };
}

function transformBackendEntity(entity: BackendSphereEntity): unknown {
  return {
    id: entity.id,
    parentId: entity.parent_id,
    radius: entity.radius,
    position3d: entity.position_3d,
    dimensions: entity.dimensions ?? {},
    timeWindow: {
      start: entity.time_window?.start_tick ?? 0,
      end: entity.time_window?.end_tick ?? null,
    },
    tags: entity.tags ?? [],
  };
}

function parseLoadedWorld(payload: BackendWorldSnapshot): LoadedWorld {
  if (!Array.isArray(payload.entities)) {
    throw new Error("Invalid world snapshot payload: entities must be an array");
  }

  const parsedEntities = parseSphereEntities(
    payload.entities.map(transformBackendEntity),
  );
  const parent = parsedEntities.find((entity) => entity.parentId === null);
  if (!parent) {
    throw new Error("World snapshot missing a root parent sphere");
  }

  return {
    tick: payload.tick,
    world: {
      parent,
      children: parsedEntities.filter((entity) => entity.parentId === parent.id),
    },
  };
}

function toBackendCommitOperation(operation: WorldCommitOperation): BackendCommitOperation {
  switch (operation.type) {
    case "create":
      return {
        type: "create",
        sphere: toBackendSphereEntity(operation.sphere),
      };
    case "delete":
      return {
        type: "delete",
        sphere_id: operation.sphereId,
      };
    case "move":
      return {
        type: "move",
        sphere_id: operation.sphereId,
        position_3d: operation.position3d,
      };
    default:
      throw new Error("Unknown commit operation");
  }
}

export async function fetchWorldSeed(
  worldId: string,
  userId?: string,
): Promise<LoadedWorld> {
  const query = userId ? `?user_id=${encodeURIComponent(userId)}` : "";
  const response = await fetch(`/api/v1/world/${encodeURIComponent(worldId)}${query}`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch world snapshot (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as BackendWorldSnapshot;
  return parseLoadedWorld(payload);
}

export async function commitWorldChanges(
  params: CommitWorldParams,
): Promise<CommitWorldResult> {
  const requestBody: BackendCommitRequest = {
    user_id: params.userId,
    base_tick: params.baseTick,
    operations: params.operations.map(toBackendCommitOperation),
  };

  const response = await fetch(
    `/api/v1/world/${encodeURIComponent(params.worldId)}/commit`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    },
  );

  if (!response.ok) {
    const errorPayload = (await response.json()) as BackendCommitError;
    throw new WorldCommitError(
      errorPayload.message ?? "Commit failed",
      errorPayload.validation_errors ?? [],
    );
  }

  const payload = (await response.json()) as BackendCommitResponse;
  const parsedWorld = parseLoadedWorld(payload.world);

  return {
    commitId: payload.commit_id,
    savedTo: payload.saved_to,
    reason: payload.reason,
    masterTick: payload.master_tick,
    userTick: payload.user_tick,
    tick: parsedWorld.tick,
    world: parsedWorld.world,
    validationErrors: payload.validation_errors ?? [],
  };
}
