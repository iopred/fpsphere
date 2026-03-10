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
        instanceWorldId: "world-custom-001",
      },
    ];

    const changed = store.apply({
      type: "hydrateWorld",
      world: hydratedWorld,
    });

    expect(changed).toBe(true);
    expect(store.listChildSpheres()).toHaveLength(1);
    expect(store.listChildSpheres()[0].id).toBe("sphere-hydrated-001");
    expect(store.listChildSpheres()[0].instanceWorldId).toBe("world-custom-001");
  });

  it("creates and auto-selects a sphere", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const sphere: SphereEntity = {
      ...testSphere("sphere-user-101"),
      instanceWorldId: "world-template-7",
    };

    const changed = store.apply({
      type: "createSphere",
      sphere,
      selectCreated: true,
    });

    expect(changed).toBe(true);
    expect(store.listChildSpheres().some((item) => item.id === sphere.id)).toBe(true);
    expect(store.getChildSphereById(sphere.id)?.instanceWorldId).toBe("world-template-7");
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

  it("enters selected sphere world and exits back to parent", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const hostId = "sphere-world-instance-001";

    expect(store.apply({ type: "selectSphere", sphereId: hostId })).toBe(true);
    expect(store.apply({ type: "enterSphere", sphereId: hostId })).toBe(true);
    expect(store.getParentSphere().id).toBe(hostId);

    const nestedSphere: SphereEntity = {
      id: "sphere-nested-001",
      parentId: hostId,
      radius: 1.8,
      position3d: [0, -1, 2],
      dimensions: { money: 0.2 },
      timeWindow: { start: 0, end: null },
      tags: ["nested"],
    };

    expect(
      store.apply({
        type: "createSphere",
        sphere: nestedSphere,
      }),
    ).toBe(true);
    expect(store.listChildSpheres().some((item) => item.id === nestedSphere.id)).toBe(true);

    expect(store.apply({ type: "exitSphere" })).toBe(true);
    expect(store.getParentSphere().id).toBe("sphere-world-001");
    expect(store.listChildSpheres().some((item) => item.id === nestedSphere.id)).toBe(false);

    expect(store.apply({ type: "selectSphere", sphereId: hostId })).toBe(true);
    expect(store.apply({ type: "enterSphere", sphereId: hostId })).toBe(true);
    expect(store.listChildSpheres().some((item) => item.id === nestedSphere.id)).toBe(true);
  });

  it("lists nested descendants for template host spheres", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const hostId = "sphere-world-instance-001";

    const childSphere: SphereEntity = {
      ...testSphere("sphere-host-child-001"),
      parentId: hostId,
    };
    const grandchildSphere: SphereEntity = {
      ...testSphere("sphere-host-grandchild-001"),
      parentId: childSphere.id,
    };

    expect(
      store.apply({
        type: "createSphere",
        sphere: childSphere,
      }),
    ).toBe(true);
    expect(
      store.apply({
        type: "createSphere",
        sphere: grandchildSphere,
      }),
    ).toBe(true);

    const descendants = store
      .listDescendantsOf(hostId)
      .map((entity) => entity.id)
      .sort();

    expect(descendants).toEqual([childSphere.id, grandchildSphere.id].sort());
  });

  it("updates dimensions on a selected sphere", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const targetId = "sphere-building-001";

    const changed = store.apply({
      type: "updateSphereDimensions",
      sphereId: targetId,
      dimensions: {
        r: 0.3,
      },
    });

    expect(changed).toBe(true);
    const updated = store.getChildSphereById(targetId);
    expect(updated?.dimensions.r).toBe(0.3);
  });

  it("updates instance world reference on a selected sphere", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const targetId = "sphere-building-001";

    const changed = store.apply({
      type: "updateSphereInstanceWorld",
      sphereId: targetId,
      instanceWorldId: " world-template-2 ",
    });

    expect(changed).toBe(true);
    const updated = store.getChildSphereById(targetId);
    expect(updated?.instanceWorldId).toBe("world-template-2");
  });

  it("updates sphere position and radius", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const targetId = "sphere-building-001";

    expect(
      store.apply({
        type: "updateSpherePosition",
        sphereId: targetId,
        position3d: [5, -3, 11],
      }),
    ).toBe(true);
    expect(
      store.apply({
        type: "updateSphereRadius",
        sphereId: targetId,
        radius: 4.5,
      }),
    ).toBe(true);

    const updated = store.getChildSphereById(targetId);
    expect(updated?.position3d).toEqual([5, -3, 11]);
    expect(updated?.radius).toBe(4.5);
  });

  it("scales descendants when parent radius changes", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const hostId = "sphere-world-instance-001";
    const host = store.getSphereById(hostId);
    expect(host).not.toBeNull();
    if (!host) {
      return;
    }

    const child: SphereEntity = {
      ...testSphere("sphere-scale-child-001"),
      parentId: hostId,
      radius: 2,
      position3d: [host.position3d[0] + 3, host.position3d[1] - 1, host.position3d[2] + 5],
    };

    expect(
      store.apply({
        type: "createSphere",
        sphere: child,
      }),
    ).toBe(true);

    expect(
      store.apply({
        type: "updateSphereRadius",
        sphereId: hostId,
        radius: host.radius * 2,
      }),
    ).toBe(true);

    const scaledChild = store.getSphereById(child.id);
    expect(scaledChild).not.toBeNull();
    expect(scaledChild?.radius).toBeCloseTo(4);
    expect(scaledChild?.position3d[0]).toBeCloseTo(host.position3d[0] + 6);
    expect(scaledChild?.position3d[1]).toBeCloseTo(host.position3d[1] - 2);
    expect(scaledChild?.position3d[2]).toBeCloseTo(host.position3d[2] + 10);
  });

  it("moves descendants when parent position changes", () => {
    const store = new LocalWorldStore(buildSeedWorld());
    const hostId = "sphere-world-instance-001";
    const host = store.getSphereById(hostId);
    expect(host).not.toBeNull();
    if (!host) {
      return;
    }
    const initialHostPosition = [...host.position3d] as [number, number, number];

    const child: SphereEntity = {
      ...testSphere("sphere-move-child-001"),
      parentId: hostId,
      radius: 2,
      position3d: [
        initialHostPosition[0] + 3,
        initialHostPosition[1] - 1,
        initialHostPosition[2] + 5,
      ],
    };

    expect(
      store.apply({
        type: "createSphere",
        sphere: child,
      }),
    ).toBe(true);

    expect(
      store.apply({
        type: "updateSpherePosition",
        sphereId: hostId,
        position3d: [
          initialHostPosition[0] + 5,
          initialHostPosition[1] + 2,
          initialHostPosition[2] - 4,
        ],
      }),
    ).toBe(true);

    const movedChild = store.getSphereById(child.id);
    expect(movedChild).not.toBeNull();
    expect(movedChild?.position3d[0]).toBeCloseTo(initialHostPosition[0] + 8);
    expect(movedChild?.position3d[1]).toBeCloseTo(initialHostPosition[1] + 1);
    expect(movedChild?.position3d[2]).toBeCloseTo(initialHostPosition[2] + 1);
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
