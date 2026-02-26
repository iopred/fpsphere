export interface KeyBinding {
  keys: string[];
  codes: string[];
  mode?: "key" | "code" | "both";
}

export const KEYBINDINGS = {
  toggleOverlay: {
    // Keep overlay on physical QWERTY-O position to avoid clashing with Dvorak movement keys.
    keys: [],
    codes: ["KeyO"],
    mode: "code",
  },
  toggleEditorMode: {
    keys: ["`", "~"],
    codes: ["Backquote"],
    mode: "both",
  },
  createSphere: {
    keys: ["c"],
    codes: ["KeyC"],
    mode: "code",
  },
  deselectSphere: {
    keys: ["q"],
    codes: ["KeyQ"],
    mode: "code",
  },
  selectLookedAtSphere: {
    keys: ["e"],
    codes: ["KeyE"],
    mode: "code",
  },
  deleteSelectedSphere: {
    keys: ["z"],
    codes: ["KeyZ"],
    mode: "code",
  },
} satisfies Record<string, KeyBinding>;

export function matchesKeyBinding(event: KeyboardEvent, binding: KeyBinding): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return false;
  }

  const key = event.key.toLowerCase();
  const mode = binding.mode ?? "both";
  const keyMatches = binding.keys.includes(key);
  const codeMatches = binding.codes.includes(event.code);

  if (mode === "key") {
    return keyMatches;
  }

  if (mode === "code") {
    return codeMatches;
  }

  return keyMatches || codeMatches;
}
