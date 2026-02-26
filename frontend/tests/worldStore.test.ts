import { describe, expect, it } from "vitest";
import type { SphereEntity } from "@fpsphere/shared-types";
import { buildSeedWorld } from "../src/game/worldSeed";
import { LocalWorldStore } from "../src/game/worldStore";

function testSphere(id: string): SphereEntity {
  return {
    id,
    parentId: "sphere-world-001",
    radius: 2,
    position3d: [1, 2, 3],
    dimensions: { money: 0.5 },
    timeWindow: { start: 0, end: null },
    tags: ["test"],
  };
}

describe("LocalWorldStore", () => {
  it("hydrates from backend-loaded world snapshot shape", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const hydratedWorld = buildSeedWorld();
    hydratedWorld.children = [
      {
        ...testSphere("sphere-hydrated-001"),
        position3d: [7, -1, 2],
      },
    ];

    const changed = store.apply({
      type: "hydrateWorld",
      world: hydratedWorld,
    });

    expect(changed).toBe(true);
    expect(store.listChildSpheres()).toHaveLength(1);
    expect(store.listChildSpheres()[0].id).toBe("sphere-hydrated-001");
  });

  it("creates and auto-selects a sphere", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const sphere = testSphere("sphere-user-101");

    const changed = store.apply({
      type: "createSphere",
      sphere,
      selectCreated: true,
    });

    expect(changed).toBe(true);
    expect(store.listChildSpheres().some((item) => item.id === sphere.id)).toBe(true);
    expect(store.getSelectedSphereId()).toBe(sphere.id);
  });

  it("rejects creates with invalid parent link", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const sphere: SphereEntity = {
      ...testSphere("sphere-user-invalid-parent"),
      parentId: "not-world-parent",
    };

    const changed = store.apply({
      type: "createSphere",
      sphere,
    });

    expect(changed).toBe(false);
    expect(store.listChildSpheres().some((item) => item.id === sphere.id)).toBe(false);
  });

  it("supports select, deselect, and delete flow", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const targetId = "sphere-building-001";

    expect(store.apply({ type: "selectSphere", sphereId: targetId })).toBe(true);
    expect(store.getSelectedSphereId()).toBe(targetId);

    expect(store.apply({ type: "deselectSphere" })).toBe(true);
    expect(store.getSelectedSphereId()).toBeNull();

    expect(store.apply({ type: "deleteSphere", sphereId: targetId })).toBe(true);
    expect(store.listChildSpheres().some((item) => item.id === targetId)).toBe(false);
  });

  it("emits change events with incrementing versions", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const versions: number[] = [];

    const unsubscribe = store.subscribe((snapshot) => {
      versions.push(snapshot.version);
    });

    store.apply({
      type: "createSphere",
      sphere: testSphere("sphere-user-events"),
    });
    store.apply({ type: "deselectSphere" });
    store.apply({ type: "selectSphere", sphereId: "sphere-user-events" });

    unsubscribe();

    expect(versions).toEqual([1, 2]);
  });
});
