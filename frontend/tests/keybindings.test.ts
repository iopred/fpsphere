import { describe, expect, it } from "vitest";
import { KEYBINDINGS, matchesKeyBinding } from "../src/game/keybindings";

function keyboardEventStub(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("keybindings", () => {
  it("does not trigger overlay from Dvorak backward movement key", () => {
    const event = keyboardEventStub({
      key: "o",
      code: "KeyS",
    });
    expect(matchesKeyBinding(event, KEYBINDINGS.toggleOverlay)).toBe(false);
  });

  it("triggers overlay from physical O key regardless of layout output", () => {
    const event = keyboardEventStub({
      key: "r",
      code: "KeyO",
    });
    expect(matchesKeyBinding(event, KEYBINDINGS.toggleOverlay)).toBe(true);
  });

  it("select action triggers only from physical E key", () => {
    const physicalE = keyboardEventStub({
      key: ".",
      code: "KeyE",
    });

    const physicalD = keyboardEventStub({
      key: "e",
      code: "KeyD",
    });

    expect(matchesKeyBinding(physicalE, KEYBINDINGS.selectLookedAtSphere)).toBe(true);
    expect(matchesKeyBinding(physicalD, KEYBINDINGS.selectLookedAtSphere)).toBe(false);
  });

  it("respects modifier guards", () => {
    const event = keyboardEventStub({
      key: "q",
      code: "KeyQ",
      ctrlKey: true,
    });
    expect(matchesKeyBinding(event, KEYBINDINGS.deselectSphere)).toBe(false);
  });
});
