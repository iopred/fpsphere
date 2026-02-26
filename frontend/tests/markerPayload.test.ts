import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKER_SIZE_METERS,
  DEFAULT_WORLD_SCALE_MULTIPLIER,
  buildMarkerPayload,
  parseMarkerPayload,
} from "../src/ar/markerPayload";

describe("markerPayload", () => {
  it("builds and parses fpsphere marker payloads", () => {
    const payload = buildMarkerPayload("world-main", 0.12, 2.5);
    const parsed = parseMarkerPayload(payload);

    expect(parsed).toEqual({
      worldId: "world-main",
      markerSizeMeters: 0.12,
      worldScaleMultiplier: 2.5,
    });
  });

  it("supports legacy plain world ids", () => {
    const parsed = parseMarkerPayload("world-main");
    expect(parsed).toEqual({
      worldId: "world-main",
      markerSizeMeters: DEFAULT_MARKER_SIZE_METERS,
      worldScaleMultiplier: DEFAULT_WORLD_SCALE_MULTIPLIER,
    });
  });

  it("clamps marker size and world scale from payload", () => {
    const parsed = parseMarkerPayload("fpsphere://world/world-main?marker=5&scale=99");
    expect(parsed).not.toBeNull();
    expect(parsed?.markerSizeMeters).toBeLessThanOrEqual(0.45);
    expect(parsed?.worldScaleMultiplier).toBeLessThanOrEqual(6);
  });
});
