import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitWorldChanges,
  createWorldLevel,
  deleteWorldLevel,
  fetchAvailableWorldIds,
  fetchWorldSeed,
  WorldCommitError,
  type WorldCommitOperation,
} from "../src/game/worldApi";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("worldApi", () => {
  it("maps backend snapshot schema to loaded world", async () => {
    const payload = {
      world_id: "world-main",
      tick: 12,
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

    const loaded = await fetchWorldSeed("world-main", "user-1");

    expect(loaded.tick).toBe(12);
    expect(loaded.world.parent.id).toBe("sphere-world-001");
    expect(loaded.world.children).toHaveLength(1);
    expect(loaded.world.children[0].id).toBe("sphere-building-001");
    expect(loaded.world.children[0].position3d).toEqual([1, 2, 3]);
  });

  it("sends commit payload and maps commit response", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.user_id).toBe("user-1");
      expect(body.base_tick).toBe(4);
      expect(body.operations).toHaveLength(4);
      expect(body.operations[0].type).toBe("create");
      expect(body.operations[1].type).toBe("delete");
      expect(body.operations[2]).toEqual({
        type: "update_dimensions",
        sphere_id: "sphere-keep-001",
        dimensions: { world_template: 1 },
      });
      expect(body.operations[3]).toEqual({
        type: "update_radius",
        sphere_id: "sphere-keep-001",
        radius: 4.75,
      });

      const responsePayload = {
        commit_id: "master-7",
        saved_to: "master",
        reason: null,
        world: {
          world_id: "world-main",
          tick: 5,
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
              id: "sphere-keep-001",
              parent_id: "sphere-world-001",
              radius: 3,
              position_3d: [1, 1, 1],
              dimensions: { money: 0.3 },
              time_window: { start_tick: 0, end_tick: null },
              tags: ["object"],
            },
          ],
        },
      };

      return new Response(JSON.stringify(responsePayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const operations: WorldCommitOperation[] = [
      {
        type: "create",
        sphere: {
          id: "sphere-created-001",
          parentId: "sphere-world-001",
          radius: 2,
          position3d: [2, 2, 2],
          dimensions: { money: 0.1 },
          timeWindow: { start: 0, end: null },
          tags: ["new"],
        },
      },
      {
        type: "delete",
        sphereId: "sphere-old-001",
      },
      {
        type: "updateDimensions",
        sphereId: "sphere-keep-001",
        dimensions: { world_template: 1 },
      },
      {
        type: "updateRadius",
        sphereId: "sphere-keep-001",
        radius: 4.75,
      },
    ];

    const result = await commitWorldChanges({
      worldId: "world-main",
      userId: "user-1",
      baseTick: 4,
      operations,
    });

    expect(result.savedTo).toBe("master");
    expect(result.tick).toBe(5);
    expect(result.world.children).toHaveLength(1);
  });

  it("throws typed commit error when backend rejects commit", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          status: "error",
          message: "commit rejected",
          validation_errors: ["delete failed: sphere 'x' does not exist"],
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;

    await expect(
      commitWorldChanges({
        worldId: "world-main",
        userId: "user-1",
        baseTick: 4,
        operations: [],
      }),
    ).rejects.toBeInstanceOf(WorldCommitError);
  });

  it("loads available world ids and deduplicates entries", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          world_ids: ["world-main", "world-beta", "world-main", " "],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;

    await expect(fetchAvailableWorldIds()).resolves.toEqual(["world-main", "world-beta"]);
  });

  it("throws when available world ids payload shape is invalid", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ world_ids: "world-main" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await expect(fetchAvailableWorldIds()).rejects.toThrow(
      "Invalid world list payload: world_ids must be an array",
    );
  });

  it("creates a world level and returns its id", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual({ world_id: "world-beta" });

      return new Response(JSON.stringify({ world_id: "world-beta" }), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      });
    });

    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    await expect(createWorldLevel("world-beta")).resolves.toBe("world-beta");
  });

  it("deletes a world level", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.method).toBe("DELETE");
      return new Response(null, { status: 204 });
    });

    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    await expect(deleteWorldLevel("world-beta")).resolves.toBeUndefined();
  });

  it("throws create world error from backend message", async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(
        JSON.stringify({ status: "error", message: "world 'world-beta' already exists" }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof globalThis.fetch;

    await expect(createWorldLevel("world-beta")).rejects.toThrow(
      "world 'world-beta' already exists",
    );
  });
});
