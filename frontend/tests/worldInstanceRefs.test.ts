import { describe, expect, it } from "vitest";
import {
  decodeTemplateIdFromInstanceWorldId,
  encodeTemplateInstanceWorldId,
  normalizeInstanceWorldIdForRuntime,
  resolveTemplateIdFromEntity,
} from "../src/game/worldInstanceRefs";

describe("worldInstanceRefs", () => {
  it("encodes and decodes template instance world ids", () => {
    const encoded = encodeTemplateInstanceWorldId(12);
    expect(encoded).toBe("world-template-12");
    expect(decodeTemplateIdFromInstanceWorldId(encoded)).toBe(12);
  });

  it("normalizes explicit instance world ids with precedence over template dimensions", () => {
    const normalized = normalizeInstanceWorldIdForRuntime({
      instanceWorldId: "world-castle",
      dimensions: { world_template: 3 },
    });
    expect(normalized).toBe("world-castle");
  });

  it("normalizes template dimensions into runtime instance world id references", () => {
    const normalized = normalizeInstanceWorldIdForRuntime({
      dimensions: { world_template: 2 },
    });
    expect(normalized).toBe("world-template-2");
  });

  it("resolves template id from instance reference before template dimensions", () => {
    const resolved = resolveTemplateIdFromEntity({
      instanceWorldId: "world-template-5",
      dimensions: { world_template: 2 },
    });
    expect(resolved).toBe(5);
  });

  it("resolves template id from template dimensions when no instance reference exists", () => {
    const resolved = resolveTemplateIdFromEntity({
      instanceWorldId: null,
      dimensions: { world_template: 7 },
    });
    expect(resolved).toBe(7);
  });
});
