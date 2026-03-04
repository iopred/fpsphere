import type { AvatarId } from "./avatarRenderAdapter";
import type { WorldSourceState } from "./levelLifecycleController";

export interface GameplayHudPanelDebugState {
  editorMode: boolean;
  tick: number;
  playerPosition: { x: number; y: number; z: number };
  playerVelocity: { x: number; y: number; z: number };
  playerGrounded: boolean;
  lastCollisionCount: number;
  overlayEnabled: boolean;
  draggingSphereId: string | null;
  createTemplateId: number;
  selectedAvatarId: AvatarId;
  selectedSphereId: string | null;
  currentWorldId: string;
  availableWorldCount: number;
  parentSphereId: string;
  obstacleCount: number;
  worldSourceState: WorldSourceState;
  backendWorldTick: number;
  pendingCommitCount: number;
  saveMessage: string;
  userId: string;
  multiplayerStatus: string;
  localPlayerId: string | null;
  remotePlayerCount: number;
  ackedInputSequence: number;
  pendingPredictedInputCount: number;
  lastSnapshotTick: number;
  reconciliationErrorDistance: number;
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
        "EDIT MODE | ~ exit editor | C create | E select | F enter selected template / exit | Q deselect | Z delete | wheel resize | hold RMB drag | hold R + mouse rotate template | Cmd/Ctrl+S save";
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
      `velocity: ${state.playerVelocity.x.toFixed(2)}, ${state.playerVelocity.y.toFixed(2)}, ${state.playerVelocity.z.toFixed(2)}\n` +
      `grounded: ${state.playerGrounded ? "yes" : "no"}\n` +
      `collisions: ${state.lastCollisionCount}\n` +
      `overlay: ${state.overlayEnabled ? "money (blue)" : "off"}\n` +
      `editor: ${state.editorMode ? "on" : "off"}\n` +
      `dragging: ${state.draggingSphereId ?? "none"}\n` +
      `create template: ${state.createTemplateId}\n` +
      `avatar: ${state.selectedAvatarId}\n` +
      `selected: ${state.selectedSphereId ?? "none"}\n` +
      `world id: ${state.currentWorldId}\n` +
      `levels: ${state.availableWorldCount}\n` +
      `world parent: ${state.parentSphereId}\n` +
      `spheres: ${state.obstacleCount}\n` +
      `world source: ${state.worldSourceState}\n` +
      `world tick: ${state.backendWorldTick}\n` +
      `pending edits: ${state.pendingCommitCount}\n` +
      `save: ${state.saveMessage}\n` +
      `user: ${state.userId}\n` +
      `multiplayer: ${state.multiplayerStatus}\n` +
      `player id: ${state.localPlayerId ?? "pending"}\n` +
      `remote players: ${state.remotePlayerCount}\n` +
      `input seq ack: ${state.ackedInputSequence}\n` +
      `pending predicted inputs: ${state.pendingPredictedInputCount}\n` +
      `last snapshot tick: ${state.lastSnapshotTick}\n` +
      `reconcile error: ${state.reconciliationErrorDistance.toFixed(4)}\n` +
      `mp error: ${state.multiplayerError ?? "none"}`;
  }
}
