import { describe, expect, it } from "vitest";
import {
  decodeLegacyTemplateIdFromInstanceWorldId,
  encodeLegacyTemplateInstanceWorldId,
  normalizeInstanceWorldIdForRuntime,
  resolveTemplateIdForLegacyCompatibility,
} from "../src/game/worldInstanceRefs";

describe("worldInstanceRefs", () => {
  it("encodes and decodes legacy template instance world ids", () => {
    const encoded = encodeLegacyTemplateInstanceWorldId(12);
    expect(encoded).toBe("legacy-template:12");
    expect(decodeLegacyTemplateIdFromInstanceWorldId(encoded)).toBe(12);
  });

  it("normalizes explicit instance world ids with precedence over legacy dimensions", () => {
    const normalized = normalizeInstanceWorldIdForRuntime({
      instanceWorldId: "world-castle",
      dimensions: { world_template: 3 },
    });
    expect(normalized).toBe("world-castle");
  });

  it("normalizes legacy template dimensions into runtime instance world id references", () => {
    const normalized = normalizeInstanceWorldIdForRuntime({
      dimensions: { world_template: 2 },
    });
    expect(normalized).toBe("legacy-template:2");
  });

  it("resolves template id from instance reference before legacy dimensions", () => {
    const resolved = resolveTemplateIdForLegacyCompatibility({
      instanceWorldId: "legacy-template:5",
      dimensions: { world_template: 2 },
    });
    expect(resolved).toBe(5);
  });

  it("resolves template id from legacy dimensions when no instance reference exists", () => {
    const resolved = resolveTemplateIdForLegacyCompatibility({
      instanceWorldId: null,
      dimensions: { world_template: 7 },
    });
    expect(resolved).toBe(7);
  });
});
