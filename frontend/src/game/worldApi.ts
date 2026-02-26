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

export async function fetchWorldSeed(worldId: string): Promise<SeedWorld> {
  const response = await fetch(`/api/v1/world/${encodeURIComponent(worldId)}`);
  if (!response.ok) {
    throw new Error(
      `Failed to fetch world snapshot (${response.status} ${response.statusText})`,
    );
  }

  const payload = (await response.json()) as BackendWorldSnapshot;
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
    parent,
    children: parsedEntities.filter((entity) => entity.parentId === parent.id),
  };
}
