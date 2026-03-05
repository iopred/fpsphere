import { describe, expect, it } from "vitest";
import { tintWorldInstanceChildDimensions } from "../src/game/worldInstanceTint";

const defaults = {
  r: 0.4706,
  g: 0.5176,
  b: 0.6078,
} as const;

const colorDimensionKeys = {
  red: "r",
  green: "g",
  blue: "b",
} as const;

describe("tintWorldInstanceChildDimensions", () => {
  it("keeps child color unchanged when host color is default", () => {
    const tinted = tintWorldInstanceChildDimensions({
      childDimensions: {
        money: 0.25,
        r: 0.9,
        g: 0.3,
        b: 0.2,
      },
      hostDimensions: {},
      defaultColorChannels: defaults,
      colorDimensionKeys,
    });

    expect(tinted.r).toBeCloseTo(0.9);
    expect(tinted.g).toBeCloseTo(0.3);
    expect(tinted.b).toBeCloseTo(0.2);
    expect(tinted.money).toBeCloseTo(0.25);
  });

  it("tints default child color to host color", () => {
    const tinted = tintWorldInstanceChildDimensions({
      childDimensions: {
        money: 0.6,
      },
      hostDimensions: {
        r: 0.82,
        g: 0.21,
        b: 0.14,
      },
      defaultColorChannels: defaults,
      colorDimensionKeys,
    });

    expect(tinted.r).toBeCloseTo(0.82, 3);
    expect(tinted.g).toBeCloseTo(0.21, 3);
    expect(tinted.b).toBeCloseTo(0.14, 3);
    expect(tinted.money).toBeCloseTo(0.6);
  });

  it("scales child colors relative to defaults and clamps to [0, 1]", () => {
    const tinted = tintWorldInstanceChildDimensions({
      childDimensions: {
        r: 0.7,
        g: 0.9,
        b: 0.65,
      },
      hostDimensions: {
        r: 1,
        g: 0,
        b: 1,
      },
      defaultColorChannels: defaults,
      colorDimensionKeys,
    });

    expect(tinted.r).toBe(1);
    expect(tinted.g).toBe(0);
    expect(tinted.b).toBe(1);
  });
});
