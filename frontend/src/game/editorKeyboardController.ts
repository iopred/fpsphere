import { KEYBINDINGS, matchesKeyBinding } from "./keybindings";

export interface EditorKeyboardCallbacks {
  requestSave: () => void;
  isEditorMode: () => boolean;
  toggleOverlay: () => void;
  toggleEditorMode: () => void;
  createSphere: () => void;
  deselectSphere: () => void;
  selectSphereAtReticle: () => void;
  enterSelectedSphereWorld: () => void;
  deleteSelectedSphere: () => void;
}

export class EditorKeyboardController {
  constructor(private readonly callbacks: EditorKeyboardCallbacks) {}

  handleKeyDown(event: KeyboardEvent): void {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      this.callbacks.requestSave();
      return;
    }

    if (this.isTypingTarget(event.target) || event.isComposing) {
      return;
    }

    if (event.repeat) {
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.toggleOverlay)) {
      event.preventDefault();
      this.callbacks.toggleOverlay();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.toggleEditorMode)) {
      event.preventDefault();
      this.callbacks.toggleEditorMode();
      return;
    }

    if (!this.callbacks.isEditorMode()) {
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.createSphere)) {
      event.preventDefault();
      this.callbacks.createSphere();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.deselectSphere)) {
      event.preventDefault();
      this.callbacks.deselectSphere();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.selectLookedAtSphere)) {
      event.preventDefault();
      this.callbacks.selectSphereAtReticle();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.enterSelectedSphereWorld)) {
      event.preventDefault();
      this.callbacks.enterSelectedSphereWorld();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.deleteSelectedSphere)) {
      event.preventDefault();
      this.callbacks.deleteSelectedSphere();
    }
  }

  private isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) {
      return false;
    }

    const editableElement = target.closest("input, textarea, select, [contenteditable]");
    if (!editableElement) {
      return false;
    }

    if (!(editableElement instanceof HTMLInputElement)) {
      return true;
    }

    const inputType = editableElement.type.toLowerCase();
    return ![
      "button",
      "checkbox",
      "color",
      "file",
      "hidden",
      "image",
      "radio",
      "range",
      "reset",
      "submit",
    ].includes(inputType);
  }
}
