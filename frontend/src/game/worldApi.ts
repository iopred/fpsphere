import type { SphereEntity } from "@fpsphere/shared-types";
import { parseSphereEntities } from "@fpsphere/shared-types";
import type { SeedWorld } from "./worldSeed";

export interface BackendTimeWindow {
  start_tick: number;
  end_tick: number | null;
}

export interface BackendSphereEntity {
  id: string;
  parent_id: string | null;
  radius: number;
  position_3d: [number, number, number];
  dimensions: Record<string, number>;
  time_window: BackendTimeWindow;
  tags: string[];
}

export interface BackendWorldSnapshot {
  world_id: string;
  tick: number;
  entities: BackendSphereEntity[];
}

interface BackendCommitResponse {
  commit_id: string;
  saved_to: "master" | "user";
  reason: string | null;
  world: BackendWorldSnapshot;
}

interface BackendWorldListResponse {
  world_ids: string[];
}

interface BackendWorldMutationResponse {
  world_id: string;
}

interface BackendCommitError {
  status: string;
  message: string;
  validation_errors?: string[];
}

interface BackendWorldMutationError {
  status: string;
  message: string;
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
    }
  | {
      type: "update_dimensions";
      sphere_id: string;
      dimensions: Record<string, number>;
    }
  | {
      type: "update_radius";
      sphere_id: string;
      radius: number;
    };

export interface LoadedWorld {
  world: SeedWorld;
  tick: number;
}

export interface TemporalWorldQuery {
  tick?: number;
  windowStartTick?: number;
  windowEndTick?: number | null;
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
    }
  | {
      type: "updateDimensions";
      sphereId: string;
      dimensions: Record<string, number>;
    }
  | {
      type: "updateRadius";
      sphereId: string;
      radius: number;
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
  tick: number;
  world: SeedWorld;
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

export function parseLoadedWorldSnapshot(payload: BackendWorldSnapshot): LoadedWorld {
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
      children: parsedEntities.filter((entity) => entity.id !== parent.id),
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
    case "updateDimensions":
      return {
        type: "update_dimensions",
        sphere_id: operation.sphereId,
        dimensions: operation.dimensions,
      };
    case "updateRadius":
      return {
        type: "update_radius",
        sphere_id: operation.sphereId,
        radius: operation.radius,
      };
    default:
      throw new Error("Unknown commit operation");
  }
}

function toNonNegativeInteger(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function appendTemporalWorldQuery(
  searchParams: URLSearchParams,
  temporalQuery?: TemporalWorldQuery,
): void {
  if (!temporalQuery) {
    return;
  }

  let parsedTick: number | null = null;
  if (temporalQuery.tick !== undefined) {
    parsedTick = toNonNegativeInteger(temporalQuery.tick, "tick");
    searchParams.set(
      "tick",
      String(parsedTick),
    );
  }

  let parsedWindowStartTick: number | null = null;
  if (temporalQuery.windowStartTick !== undefined) {
    parsedWindowStartTick = toNonNegativeInteger(
      temporalQuery.windowStartTick,
      "windowStartTick",
    );
    searchParams.set("window_start_tick", String(parsedWindowStartTick));
  }

  if (temporalQuery.windowEndTick !== undefined) {
    if (parsedWindowStartTick === null) {
      throw new Error("windowEndTick requires windowStartTick");
    }

    if (temporalQuery.windowEndTick === null) {
      return;
    }

    const parsedWindowEndTick = toNonNegativeInteger(
      temporalQuery.windowEndTick,
      "windowEndTick",
    );
    if (parsedWindowEndTick < parsedWindowStartTick) {
      throw new Error("windowEndTick must be >= windowStartTick");
    }

    searchParams.set("window_end_tick", String(parsedWindowEndTick));
  }

  if (parsedTick !== null) {
    if (parsedWindowStartTick !== null && parsedTick < parsedWindowStartTick) {
      throw new Error("tick must be >= windowStartTick");
    }

    if (
      temporalQuery.windowEndTick !== undefined &&
      temporalQuery.windowEndTick !== null &&
      parsedTick > temporalQuery.windowEndTick
    ) {
      throw new Error("tick must be <= windowEndTick");
    }
  }
}

function isEntityActiveAtTick(entity: SphereEntity, tick: number): boolean {
  if (tick < entity.timeWindow.start) {
    return false;
  }

  return entity.timeWindow.end === null || tick <= entity.timeWindow.end;
}

function doesEntityOverlapWindow(
  entity: SphereEntity,
  windowStartTick: number,
  windowEndTick: number | null,
): boolean {
  if (windowEndTick !== null && entity.timeWindow.start > windowEndTick) {
    return false;
  }

  return entity.timeWindow.end === null || entity.timeWindow.end >= windowStartTick;
}

function isEntityVisibleForTemporalQuery(
  entity: SphereEntity,
  temporalQuery: TemporalWorldQuery,
): boolean {
  if (
    temporalQuery.tick !== undefined &&
    !isEntityActiveAtTick(entity, temporalQuery.tick)
  ) {
    return false;
  }

  if (
    temporalQuery.windowStartTick !== undefined &&
    !doesEntityOverlapWindow(
      entity,
      temporalQuery.windowStartTick,
      temporalQuery.windowEndTick ?? null,
    )
  ) {
    return false;
  }

  return true;
}

function filterLoadedWorldByTemporalQuery(
  loaded: LoadedWorld,
  temporalQuery?: TemporalWorldQuery,
): LoadedWorld {
  if (
    !temporalQuery ||
    (temporalQuery.tick === undefined &&
      temporalQuery.windowStartTick === undefined &&
      temporalQuery.windowEndTick === undefined)
  ) {
    return loaded;
  }

  const includedIds = new Set<string>([loaded.world.parent.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entity of loaded.world.children) {
      if (includedIds.has(entity.id)) {
        continue;
      }

      const parentId = entity.parentId;
      if (!parentId || !includedIds.has(parentId)) {
        continue;
      }

      if (!isEntityVisibleForTemporalQuery(entity, temporalQuery)) {
        continue;
      }

      includedIds.add(entity.id);
      changed = true;
    }
  }

  return {
    tick: loaded.tick,
    world: {
      parent: loaded.world.parent,
      children: loaded.world.children.filter((entity) => includedIds.has(entity.id)),
    },
  };
}

export async function fetchWorldSeed(
  worldId: string,
  userId?: string,
  temporalQuery?: TemporalWorldQuery,
): Promise<LoadedWorld> {
  const searchParams = new URLSearchParams();
  if (userId) {
    searchParams.set("user_id", userId);
  }
  appendTemporalWorldQuery(searchParams, temporalQuery);

  const query = searchParams.toString();
  const response = await fetch(
    `/api/v1/world/${encodeURIComponent(worldId)}${query.length > 0 ? `?${query}` : ""}`,
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch world snapshot (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as BackendWorldSnapshot;
  const loaded = parseLoadedWorldSnapshot(payload);
  return filterLoadedWorldByTemporalQuery(loaded, temporalQuery);
}

export async function fetchAvailableWorldIds(): Promise<string[]> {
  const response = await fetch("/api/v1/worlds");
  if (!response.ok) {
    throw new Error(
      `Failed to fetch available worlds (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as BackendWorldListResponse;
  if (!Array.isArray(payload.world_ids)) {
    throw new Error("Invalid world list payload: world_ids must be an array");
  }

  const uniqueWorldIds: string[] = [];
  const seenWorldIds = new Set<string>();
  for (const value of payload.world_ids) {
    if (typeof value !== "string") {
      continue;
    }

    const worldId = value.trim();
    if (worldId.length === 0 || seenWorldIds.has(worldId)) {
      continue;
    }

    seenWorldIds.add(worldId);
    uniqueWorldIds.push(worldId);
  }

  return uniqueWorldIds;
}

export async function createWorldLevel(worldIdInput: string): Promise<string> {
  const worldId = worldIdInput.trim();
  if (worldId.length === 0) {
    throw new Error("world_id is required");
  }

  const response = await fetch("/api/v1/world", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ world_id: worldId }),
  });

  if (!response.ok) {
    const errorPayload = (await response.json()) as BackendWorldMutationError;
    throw new Error(errorPayload.message ?? "Failed to create world");
  }

  const payload = (await response.json()) as BackendWorldMutationResponse;
  if (typeof payload.world_id !== "string" || payload.world_id.trim().length === 0) {
    throw new Error("Invalid create world response payload: world_id is required");
  }

  return payload.world_id.trim();
}

export async function deleteWorldLevel(worldIdInput: string): Promise<void> {
  const worldId = worldIdInput.trim();
  if (worldId.length === 0) {
    throw new Error("world_id is required");
  }

  const response = await fetch(`/api/v1/world/${encodeURIComponent(worldId)}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const errorPayload = (await response.json()) as BackendWorldMutationError;
    throw new Error(errorPayload.message ?? "Failed to delete world");
  }
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
  const parsedWorld = parseLoadedWorldSnapshot(payload.world);

  return {
    commitId: payload.commit_id,
    savedTo: payload.saved_to,
    reason: payload.reason,
    tick: parsedWorld.tick,
    world: parsedWorld.world,
  };
}
