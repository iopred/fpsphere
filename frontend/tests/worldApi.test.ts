import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWorldSeed } from "../src/game/worldApi";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchWorldSeed", () => {
  it("maps backend snapshot schema to seed world", async () => {
    const payload = {
      world_id: "world-main",
      tick: 0,
      entities: [
        {
          id: "sphere-world-001",
          parent_id: null,
          radius: 60,
          position_3d: [0, 0, 0],
          dimensions: { money: 0 },
          time_window: { start_tick: 0, end_tick: null },
          tags: ["world"],
        },
        {
          id: "sphere-building-001",
          parent_id: "sphere-world-001",
          radius: 9,
          position_3d: [1, 2, 3],
          dimensions: { money: 0.2 },
          time_window: { start_tick: 0, end_tick: null },
          tags: ["building"],
        },
      ],
    };

    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const world = await fetchWorldSeed("world-main");

    expect(world.parent.id).toBe("sphere-world-001");
    expect(world.children).toHaveLength(1);
    expect(world.children[0].id).toBe("sphere-building-001");
    expect(world.children[0].position3d).toEqual([1, 2, 3]);
  });

  it("throws on non-OK backend response", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(null, { status: 500, statusText: "Server Error" });
    }) as typeof globalThis.fetch;

    await expect(fetchWorldSeed("world-main")).rejects.toThrow(
      "Failed to fetch world snapshot",
    );
  });
});
