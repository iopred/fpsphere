import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSeedWorld } from "../src/game/worldSeed";
import { LevelLifecycleController, type LevelLifecycleCallbacks } from "../src/game/levelLifecycleController";
import * as worldApi from "../src/game/worldApi";

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;

interface ControllerHarness {
  controller: LevelLifecycleController;
  callbacks: {
    connectMultiplayer: ReturnType<typeof vi.fn>;
    movePlayerToCurrentWorld: ReturnType<typeof vi.fn>;
  };
  ui: {
    levelSelectDropdown: HTMLSelectElement;
    levelSelectStatusNode: HTMLDivElement;
    levelCreateInput: HTMLInputElement;
    levelCreateButton: HTMLButtonElement;
    levelRemoveButton: HTMLButtonElement;
    levelSelectRefreshButton: HTMLButtonElement;
  };
}

function mockBackendWorldId(worldId: string): void {
  vi.spyOn(worldApi, "fetchWorldSeed").mockResolvedValue({
    tick: 1,
    world: {
      ...buildSeedWorld(),
      parent: {
        ...buildSeedWorld().parent,
        id: `${worldId}-root`,
      },
    },
  });
}

function createControllerHarness(options?: {
  connectMultiplayer?: () => void;
}): ControllerHarness {
  let pendingOperations: worldApi.WorldCommitOperation[] = [];
  const connectMultiplayer = vi.fn(options?.connectMultiplayer);
  const movePlayerToCurrentWorld = vi.fn();

  const callbacks: LevelLifecycleCallbacks = {
    userId: "user-1",
    isDisposed: () => false,
    isEditorMode: () => true,
    getPendingCommitOperations: () => pendingOperations,
    replacePendingCommitOperations: (operations) => {
      pendingOperations = operations;
    },
    stopDraggingSphere: vi.fn(),
    deselectSphere: vi.fn(),
    updateWorldQueryParam: vi.fn(),
    connectMultiplayer,
    movePlayerToCurrentWorld,
    hydrateWorld: vi.fn(() => true),
    getWorldContext: () => null,
  };

  const levelSelectDropdown = {
    value: "",
    textContent: "",
    disabled: false,
    appendChild: vi.fn(),
  } as unknown as HTMLSelectElement;
  const levelSelectStatusNode = {
    textContent: "",
  } as HTMLDivElement;
  const levelCreateInput = {
    disabled: false,
    value: "",
  } as unknown as HTMLInputElement;
  const levelCreateButton = {
    disabled: false,
  } as HTMLButtonElement;
  const levelRemoveButton = {
    disabled: false,
  } as HTMLButtonElement;
  const levelSelectRefreshButton = {
    disabled: false,
  } as HTMLButtonElement;

  const controller = new LevelLifecycleController({
    defaultWorldId: "world-main",
    ui: {
      levelSelectNode: { hidden: false } as HTMLDivElement,
      levelSelectStatusNode,
      levelSelectDropdown,
      levelRemoveButton,
      levelCreateInput,
      levelCreateButton,
      levelSelectRefreshButton,
    },
    callbacks,
  });

  return {
    controller,
    callbacks: {
      connectMultiplayer,
      movePlayerToCurrentWorld,
    },
    ui: {
      levelSelectDropdown,
      levelSelectStatusNode,
      levelCreateInput,
      levelCreateButton,
      levelRemoveButton,
      levelSelectRefreshButton,
    },
  };
}

function restoreDomGlobals(): void {
  if (typeof originalWindow === "undefined") {
    delete (globalThis as { window?: Window }).window;
  } else {
    Object.defineProperty(globalThis, "window", {
      value: originalWindow,
      configurable: true,
      writable: true,
    });
  }

  if (typeof originalDocument === "undefined") {
    delete (globalThis as { document?: Document }).document;
  } else {
    Object.defineProperty(globalThis, "document", {
      value: originalDocument,
      configurable: true,
      writable: true,
    });
  }
}

describe("LevelLifecycleController", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    restoreDomGlobals();
  });

  it("deleting the current world switches to another world and keeps controls usable", async () => {
    Object.defineProperty(globalThis, "window", {
      value: { confirm: vi.fn(() => true) },
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, "document", {
      value: { createElement: vi.fn(() => ({ value: "", textContent: "" })) },
      configurable: true,
      writable: true,
    });

    const fetchWorldIdsMock = vi
      .spyOn(worldApi, "fetchAvailableWorldIds")
      .mockResolvedValueOnce(["world-main", "world-template-1"])
      .mockResolvedValueOnce(["world-main", "world-template-1"]);
    vi.spyOn(worldApi, "deleteWorldLevel").mockResolvedValue();
    mockBackendWorldId("world-template-1");

    const harness = createControllerHarness();
    await harness.controller.refreshAvailableWorldIds({ preserveCurrentWorldId: true });

    await harness.controller.deleteWorldLevelById("world-main");

    expect(fetchWorldIdsMock).toHaveBeenCalledTimes(2);
    expect(harness.controller.worldId).toBe("world-template-1");
    expect(worldApi.fetchWorldSeed).toHaveBeenCalledWith("world-template-1", "user-1");
    expect(harness.ui.levelCreateInput.disabled).toBe(false);
    expect(harness.ui.levelCreateButton.disabled).toBe(false);
    expect(harness.ui.levelRemoveButton.disabled).toBe(true);
    expect(harness.ui.levelSelectRefreshButton.disabled).toBe(false);
    expect(harness.ui.levelSelectStatusNode.textContent).toBe('Current: world-template-1');
  });

  it("always clears loading state when multiplayer reconnect throws", async () => {
    Object.defineProperty(globalThis, "document", {
      value: { createElement: vi.fn(() => ({ value: "", textContent: "" })) },
      configurable: true,
      writable: true,
    });

    mockBackendWorldId("world-template-2");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const harness = createControllerHarness({
      connectMultiplayer: () => {
        throw new Error("socket unavailable");
      },
    });

    await expect(harness.controller.selectWorldLevel("world-template-2", true)).resolves.toBeUndefined();

    expect(harness.controller.worldId).toBe("world-template-2");
    expect(harness.callbacks.connectMultiplayer).toHaveBeenCalledWith("world-template-2");
    expect(harness.callbacks.movePlayerToCurrentWorld).toHaveBeenCalledTimes(1);
    expect(harness.ui.levelSelectDropdown.disabled).toBe(false);
    expect(harness.ui.levelSelectStatusNode.textContent).toBe("Current: world-template-2");
  });
});
