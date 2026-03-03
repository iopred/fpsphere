import { describe, expect, it } from "vitest";
import {
  TEMPLATE_PLACEMENT_PLAYBACK_MIN_SCALE,
  TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_SCALE,
  templatePlacementPlaybackProgress,
  templatePlacementPlaybackScale,
} from "../src/game/templatePlacementPlayback";

describe("templatePlacementPlayback", () => {
  it("returns null when creation tick is in the future", () => {
    const progress = templatePlacementPlaybackProgress({
      currentTick: 10,
      startTick: 11,
      durationTicks: 30,
      maxAgeTicks: 120,
    });

    expect(progress).toBeNull();
  });

  it("returns null when creation is older than max playback age", () => {
    const progress = templatePlacementPlaybackProgress({
      currentTick: 200,
      startTick: 0,
      durationTicks: 30,
      maxAgeTicks: 120,
    });

    expect(progress).toBeNull();
  });

  it("clamps progress to 1 after duration", () => {
    const progress = templatePlacementPlaybackProgress({
      currentTick: 55,
      startTick: 10,
      durationTicks: 30,
      maxAgeTicks: 120,
    });

    expect(progress).toBe(1);
  });

  it("returns expected scale curve (intro, overshoot, settle)", () => {
    expect(templatePlacementPlaybackScale(0)).toBeCloseTo(
      TEMPLATE_PLACEMENT_PLAYBACK_MIN_SCALE,
    );
    expect(templatePlacementPlaybackScale(0.7)).toBeCloseTo(
      TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_SCALE,
    );
    expect(templatePlacementPlaybackScale(1)).toBeCloseTo(1);
    expect(templatePlacementPlaybackScale(5)).toBeCloseTo(1);
  });

  it("produces deterministic playback lifecycle values over repeated sampling", () => {
    const sampleTicks = [100, 110, 129, 142, 281];
    const readProgress = (): Array<number | null> =>
      sampleTicks.map((currentTick) =>
        templatePlacementPlaybackProgress({
          currentTick,
          startTick: 100,
          durationTicks: 42,
          maxAgeTicks: 180,
        }),
      );

    const firstProgress = readProgress();
    const secondProgress = readProgress();

    expect(firstProgress).toEqual(secondProgress);
    expect(firstProgress[0]).toBe(0);
    expect(firstProgress[1]).toBeCloseTo(10 / 42);
    expect(firstProgress[2]).toBeCloseTo(29 / 42);
    expect(firstProgress[3]).toBe(1);
    expect(firstProgress[4]).toBeNull();

    const firstScales = firstProgress.map((progress) =>
      progress === null ? null : templatePlacementPlaybackScale(progress),
    );
    const secondScales = secondProgress.map((progress) =>
      progress === null ? null : templatePlacementPlaybackScale(progress),
    );

    expect(firstScales).toEqual(secondScales);
    expect(firstScales[0]).toBeCloseTo(TEMPLATE_PLACEMENT_PLAYBACK_MIN_SCALE);
    expect(firstScales[2]).toBeGreaterThan(1);
    expect(firstScales[2]).toBeLessThanOrEqual(TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_SCALE);
    expect(firstScales[3]).toBeCloseTo(1);
    expect(firstScales[4]).toBeNull();
  });
});
