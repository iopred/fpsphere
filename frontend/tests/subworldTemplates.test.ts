import { describe, expect, it } from "vitest";
import type { SphereEntity } from "@fpsphere/shared-types";
import {
  instantiateSubworldChildren,
  resolveTemplateSeedId,
  SUBWORLD_SCALE_DIMENSION,
  SUBWORLD_TEMPLATE_DIMENSION,
} from "../src/game/subworldTemplates";
import { encodeTemplateInstanceWorldId } from "../src/game/worldInstanceRefs";

function hostSphere(overrides: Partial<SphereEntity> = {}): SphereEntity {
  return {
    id: "host-001",
    parentId: "sphere-world-001",
    radius: 24,
    position3d: [10, 2, -4],
    dimensions: {
      money: 0.4,
      [SUBWORLD_TEMPLATE_DIMENSION]: 1,
      [SUBWORLD_SCALE_DIMENSION]: 1,
    },
    timeWindow: { start: 0, end: null },
    tags: ["world-instance"],
    ...overrides,
  };
}

describe("subworldTemplates", () => {
  it("instantiates template children scaled by host radius", () => {
    const derived = instantiateSubworldChildren([hostSphere()]);
    expect(derived).toHaveLength(3);

    const ground = derived.find((item) => item.id.endsWith("ground-shell"));
    expect(ground).toBeDefined();
    expect(ground?.parentId).toBe("host-001");
    expect(ground?.radius).toBeCloseTo(20.8);
    expect(ground?.position3d[0]).toBeCloseTo(10);
    expect(ground?.position3d[1]).toBeCloseTo(-21);
    expect(ground?.position3d[2]).toBeCloseTo(-4);
    expect(ground?.tags.includes("instanced-subworld")).toBe(true);
  });

  it("applies optional world_scale and falls back unknown templates to default seed", () => {
    const scaled = instantiateSubworldChildren([
      hostSphere({
        id: "host-scale",
        dimensions: {
          money: 0.4,
          [SUBWORLD_TEMPLATE_DIMENSION]: 1,
          [SUBWORLD_SCALE_DIMENSION]: 0.5,
        },
      }),
      hostSphere({
        id: "host-unknown",
        dimensions: {
          money: 0.4,
          [SUBWORLD_TEMPLATE_DIMENSION]: 999,
        },
      }),
    ]);

    const scaledGround = scaled.find((item) => item.id.includes("host-scale"));
    expect(scaledGround?.radius).toBeCloseTo(10.4);
    expect(scaled.some((item) => item.id.includes("host-unknown"))).toBe(true);
    expect(scaled.some((item) => item.tags.includes("template-999"))).toBe(true);
  });

  it("resolves seed template id to default static template for unknown ids", () => {
    expect(resolveTemplateSeedId(1)).toBe(1);
    expect(resolveTemplateSeedId(999)).toBe(1);
  });

  it("instantiates from world-template instanceWorldId when world_template dimension is absent", () => {
    const derived = instantiateSubworldChildren([
      hostSphere({
        id: "host-instance-world-id",
        dimensions: { money: 0.4, [SUBWORLD_SCALE_DIMENSION]: 1 },
        instanceWorldId: encodeTemplateInstanceWorldId(1),
      }),
    ]);

    expect(derived).toHaveLength(3);
    expect(derived.some((entity) => entity.id.includes("host-instance-world-id"))).toBe(true);
  });
});
