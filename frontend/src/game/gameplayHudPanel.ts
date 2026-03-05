import type { WorldSourceState } from "./levelLifecycleController";

export interface GameplayHudPanelDebugState {
  editorMode: boolean;
  tick: number;
  playerPosition: { x: number; y: number; z: number };
  overlayEnabled: boolean;
  draggingSphereId: string | null;
  selectedSphereId: string | null;
  currentWorldId: string;
  availableWorldCount: number;
  obstacleCount: number;
  worldSourceState: WorldSourceState;
  backendWorldTick: number;
  pendingCommitCount: number;
  saveMessage: string;
  multiplayerStatus: string;
  multiplayerError: string | null;
}

export class GameplayHudPanel {
  private readonly hudNode: HTMLDivElement;
  private readonly hintNode: HTMLDivElement;

  constructor(mountNode: HTMLElement) {
    this.hudNode = document.createElement("div");
    this.hudNode.className = "hud";
    this.hudNode.hidden = true;
    mountNode.appendChild(this.hudNode);

    this.hintNode = document.createElement("div");
    this.hintNode.className = "center-hint";
    mountNode.appendChild(this.hintNode);

    const crosshairNode = document.createElement("div");
    crosshairNode.className = "crosshair";
    mountNode.appendChild(crosshairNode);
  }

  setPointerLocked(pointerLocked: boolean): void {
    this.hintNode.style.opacity = pointerLocked ? "0" : "1";
  }

  renderHint(editorMode: boolean): void {
    if (editorMode) {
      this.hintNode.textContent =
        "EDIT MODE | ~ exit editor | C create | E select | F enter selected world instance / exit | Q deselect | Z delete | world instance is selected from the editor panel | wheel resize | hold RMB drag | hold R + mouse rotate template | Cmd/Ctrl+S save";
      return;
    }

    this.hintNode.textContent = "Click to lock pointer | WASD + Space | ~ editor mode";
  }

  renderDebug(state: GameplayHudPanelDebugState): void {
    this.hudNode.hidden = !state.editorMode;
    if (!state.editorMode) {
      return;
    }

    this.hudNode.textContent =
      `tick: ${state.tick}\n` +
      `position: ${state.playerPosition.x.toFixed(2)}, ${state.playerPosition.y.toFixed(2)}, ${state.playerPosition.z.toFixed(2)}\n` +
      `overlay: ${state.overlayEnabled ? "money (blue)" : "off"}\n` +
      `dragging: ${state.draggingSphereId ?? "none"}\n` +
      `selected: ${state.selectedSphereId ?? "none"}\n` +
      `world id: ${state.currentWorldId}\n` +
      `levels: ${state.availableWorldCount}\n` +
      `spheres: ${state.obstacleCount}\n` +
      `world source: ${state.worldSourceState}\n` +
      `world tick: ${state.backendWorldTick}\n` +
      `pending edits: ${state.pendingCommitCount}\n` +
      `save: ${state.saveMessage}\n` +
      `multiplayer: ${state.multiplayerStatus}\n` +
      `mp error: ${state.multiplayerError ?? "none"}`;
  }
}
