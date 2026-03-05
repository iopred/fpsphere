import { parseSphereEntities, type SphereEntity } from "@fpsphere/shared-types";

export interface SeedWorld {
  parent: SphereEntity;
  children: SphereEntity[];
}

const seedPayload: unknown[] = [
  {
    id: "sphere-world-001",
    parentId: null,
    radius: 60,
    position3d: [0, 0, 0],
    dimensions: { money: 0 },
    timeWindow: { start: 0, end: null },
    tags: ["world"],
  },
  {
    id: "sphere-ground-001",
    parentId: "sphere-world-001",
    radius: 50,
    position3d: [0, -55, 0],
    dimensions: { money: 0.1 },
    timeWindow: { start: 0, end: null },
    tags: ["ground"],
  },
  {
    id: "sphere-building-001",
    parentId: "sphere-world-001",
    radius: 9,
    position3d: [-12, -2, -6],
    dimensions: { money: 0.6 },
    timeWindow: { start: 0, end: null },
    tags: ["building"],
  },
  {
    id: "sphere-building-002",
    parentId: "sphere-world-001",
    radius: 7,
    position3d: [10, -1, -10],
    dimensions: { money: 0.2 },
    timeWindow: { start: 0, end: null },
    tags: ["building"],
  },
  {
    id: "sphere-resource-001",
    parentId: "sphere-world-001",
    radius: 3,
    position3d: [3, -3, 8],
    dimensions: { money: 1.0 },
    timeWindow: { start: 0, end: null },
    tags: ["resource"],
  },
  {
    id: "sphere-world-instance-001",
    parentId: "sphere-world-001",
    radius: 12,
    position3d: [18, -2, 14],
    dimensions: {
      money: 0.35,
      world_template: 1,
      world_scale: 1,
    },
    instanceWorldId: "world-template-1",
    timeWindow: { start: 0, end: null },
    tags: ["world-instance"],
  },
];

export function buildSeedWorld(): SeedWorld {
  const entities = parseSphereEntities(seedPayload);
  const parent = entities.find((entity) => entity.parentId === null);

  if (!parent) {
    throw new Error("seedPayload must include a root world sphere");
  }

  return {
    parent,
    children: entities.filter((entity) => entity.id !== parent.id),
  };
}
