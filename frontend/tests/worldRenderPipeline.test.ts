import { describe, expect, it, vi } from "vitest";
import type { SphereEntity } from "@fpsphere/shared-types";
import type { SeedWorld } from "../src/game/worldSeed";
import type { WorldStoreSnapshot } from "../src/game/worldStore";
import {
  DEFAULT_WORLD_INSTANCE_RENDER_DEPTH,
  expandWorldRenderEntities,
} from "../src/game/worldRenderPipeline";

function sphere(overrides: Partial<SphereEntity> = {}): SphereEntity {
  return {
    id: "sphere-root",
    parentId: null,
    radius: 20,
    position3d: [0, 0, 0],
    dimensions: { money: 0 },
    instanceWorldId: null,
    timeWindow: { start: 0, end: null },
    tags: ["world"],
    ...overrides,
  };
}

function makeSnapshot(host: SphereEntity): WorldStoreSnapshot {
  return {
    parent: sphere(),
    children: [host],
    selectedSphereId: null,
    version: 1,
  };
}

function makeReferencedWorld(): SeedWorld {
  return {
    parent: sphere({
      id: "template-root",
      radius: 10,
      tags: ["world"],
    }),
    children: [
      sphere({
        id: "template-child",
        parentId: "template-root",
        radius: 1.5,
        position3d: [2, -1, 0.5],
        dimensions: { money: 0.4 },
        tags: ["resource"],
      }),
    ],
  };
}

function expandForSnapshot(snapshot: WorldStoreSnapshot): SphereEntity[] {
  const entitiesById = new Map<string, SphereEntity>([
    [snapshot.parent.id, snapshot.parent],
    ...snapshot.children.map((entity) => [entity.id, entity] as const),
  ]);
  const instancedWorldById = new Map<string, SeedWorld>([
    ["world-template-1", makeReferencedWorld()],
  ]);
  const ensureLoaded = vi.fn<(worldId: string) => void>();

  return expandWorldRenderEntities({
    snapshot,
    currentWorldId: "world-main",
    listDescendantsOf: (parentId) => {
      const descendants: SphereEntity[] = [];
      const queue: string[] = [parentId];
      while (queue.length > 0) {
        const currentParent = queue.shift();
        if (!currentParent) {
          continue;
        }
        const children = [...entitiesById.values()].filter(
          (entity) => entity.parentId === currentParent,
        );
        for (const child of children) {
          descendants.push(child);
          queue.push(child.id);
        }
      }
      return descendants;
    },
    instancedWorldById,
    ensureInstancedWorldLoaded: ensureLoaded,
    worldInstanceRenderDepth: DEFAULT_WORLD_INSTANCE_RENDER_DEPTH,
    colorConfig: {
      defaultColorChannels: { r: 0.4706, g: 0.5176, b: 0.6078 },
      colorDimensionKeys: { red: "r", green: "g", blue: "b" },
    },
  });
}

function projectInstancedEntities(entities: SphereEntity[]): Array<{
  radius: number;
  position3d: [number, number, number];
  dimensions: Record<string, number>;
}> {
  return entities
    .filter((entity) => entity.tags.includes("instanced-subworld"))
    .map((entity) => ({
      radius: Number(entity.radius.toFixed(4)),
      position3d: [
        Number(entity.position3d[0].toFixed(4)),
        Number(entity.position3d[1].toFixed(4)),
        Number(entity.position3d[2].toFixed(4)),
      ],
      dimensions: entity.dimensions,
    }));
}

describe("worldRenderPipeline", () => {
  it("expands referenced worlds from explicit instanceWorldId", () => {
    const host = sphere({
      id: "host",
      parentId: "sphere-root",
      radius: 10,
      dimensions: {
        money: 0.25,
      },
      instanceWorldId: "world-template-1",
      tags: ["world-instance"],
    });

    const expanded = expandForSnapshot(makeSnapshot(host));
    const hasReferencedWorldTag = expanded.some((entity) =>
      entity.tags.some((tag) => tag === "world-instance-world-template-1"),
    );

    expect(hasReferencedWorldTag).toBe(true);
    expect(projectInstancedEntities(expanded)).toHaveLength(1);
  });

  it("does not expand worlds from legacy world_template dimensions", () => {
    const host = sphere({
      id: "host",
      parentId: "sphere-root",
      radius: 10,
      dimensions: {
        money: 0.25,
        world_template: 1,
      },
      tags: ["world-instance"],
    });

    const expanded = expandForSnapshot(makeSnapshot(host));

    expect(projectInstancedEntities(expanded)).toEqual([]);
  });
});
