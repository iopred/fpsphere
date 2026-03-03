import * as THREE from "three";
import type { SphereEntity } from "@fpsphere/shared-types";
import { FpsController } from "./FpsController";
import {
  constrainInsideParentSphere,
  resolveSphereCollisions,
  type ObstacleBody,
  type PlayerBody,
} from "./physics";
import { KEYBINDINGS, matchesKeyBinding } from "./keybindings";
import {
  getAvailableSubworldTemplateIds,
  getTemplateRootRadius,
  getTemplateRootSphereId,
  instantiateSubworldChildren,
  resolveTemplateSeedId,
  TEMPLATE_DEFINITION_TAG,
  TEMPLATE_ROOT_TAG,
  SUBWORLD_SCALE_DIMENSION,
  SUBWORLD_TEMPLATE_DIMENSION,
} from "./subworldTemplates";
import { buildSeedWorld } from "./worldSeed";
import {
  commitWorldChanges,
  createWorldLevel,
  deleteWorldLevel,
  fetchAvailableWorldIds,
  fetchWorldSeed,
  parseLoadedWorldSnapshot,
  type WorldCommitOperation,
  WorldCommitError,
} from "./worldApi";
import {
  MultiplayerClient,
  type MultiplayerSnapshot,
  type MultiplayerWorldCommit,
  type RemotePlayerState,
} from "./multiplayerClient";
import { LocalWorldStore, type WorldStoreSnapshot } from "./worldStore";
import {
  availableAvatarIds,
  avatarLabel,
  createRemoteAvatarHandle,
  DEFAULT_AVATAR_ID,
  normalizeAvatarId,
  type AvatarId,
  type AvatarRenderHandle,
} from "./avatarRenderAdapter";

const FIXED_STEP_SECONDS = 1 / 60;
const MOVE_SPEED = 18;
const AIR_CONTROL = 3.2;
const JUMP_SPEED = 11.5;
const GRAVITY = 26;
const PLAYER_RADIUS = 1.0;
const DRAG_GROUNDED = 14;
const DRAG_AIR = 0.8;
const CREATED_SPHERE_RADIUS = 2.4;
const CREATE_DISTANCE = 8;
const CREATE_BOUNDARY_MARGIN = 0.35;
const DEFAULT_WORLD_ID = "world-main";
const NETWORK_SEND_INTERVAL_TICKS = 2;
const TEMPLATE_NONE_ID = 0;
const MIN_EDIT_RADIUS = 0.25;
const MOUSE_WHEEL_RADIUS_STEP = 0.35;
const DRAG_MIN_DISTANCE = 1.5;
const SPHERE_COLOR_RED_DIMENSION = "r";
const SPHERE_COLOR_GREEN_DIMENSION = "g";
const SPHERE_COLOR_BLUE_DIMENSION = "b";
const DEFAULT_SPHERE_COLOR_HEX = 0x78849b;
const DEFAULT_SPHERE_COLOR = new THREE.Color(DEFAULT_SPHERE_COLOR_HEX);
const DEFAULT_SPHERE_COLOR_RED = DEFAULT_SPHERE_COLOR.r;
const DEFAULT_SPHERE_COLOR_GREEN = DEFAULT_SPHERE_COLOR.g;
const DEFAULT_SPHERE_COLOR_BLUE = DEFAULT_SPHERE_COLOR.b;

interface SphereColorChannels {
  r: number;
  g: number;
  b: number;
}

interface PredictedInputState {
  sequence: number;
  simulationTick: number;
  position3d: [number, number, number];
  yaw: number;
  pitch: number;
}

interface RemotePlayerRenderState {
  renderPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  renderYaw: number;
  targetYaw: number;
  renderPitch: number;
  targetPitch: number;
  avatarId: AvatarId;
  lastServerTick: number;
}

interface RemoteAvatarRenderInstance {
  avatarId: AvatarId;
  handle: AvatarRenderHandle;
}

const tempForward = new THREE.Vector3();
const tempOffset = new THREE.Vector3();
const tempDragTarget = new THREE.Vector3();
const tempRaycastPoint = new THREE.Vector2(0, 0);
const tempLookEuler = new THREE.Euler(0, 0, 0, "YXZ");
const MAX_PENDING_PREDICTED_INPUTS = 512;
const RECONCILE_POSITION_EPSILON = 0.0001;
const REMOTE_INTERPOLATION_SMOOTH_TIME_SECONDS = 0.085;
const REMOTE_INTERPOLATION_SNAP_DISTANCE = 5;
const REMOTE_INTERPOLATION_SNAP_ANGLE_RADIANS = Math.PI * 0.75;
const REMOTE_INTERPOLATION_MAX_FRAME_SECONDS = 0.1;
const TWO_PI = Math.PI * 2;

export class GameApp {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly clock = new THREE.Clock();
  private readonly hudNode: HTMLDivElement;
  private readonly hintNode: HTMLDivElement;
  private readonly crosshairNode: HTMLDivElement;
  private readonly editorPanelsNode: HTMLDivElement;
  private readonly templateHudNode: HTMLDivElement;
  private readonly createTemplateValueNode: HTMLSpanElement;
  private readonly selectedTemplateValueNode: HTMLSpanElement;
  private readonly createTemplateDecreaseButton: HTMLButtonElement;
  private readonly createTemplateIncreaseButton: HTMLButtonElement;
  private readonly selectedTemplateDecreaseButton: HTMLButtonElement;
  private readonly selectedTemplateIncreaseButton: HTMLButtonElement;
  private readonly avatarDecreaseButton: HTMLButtonElement;
  private readonly avatarIncreaseButton: HTMLButtonElement;
  private readonly avatarValueNode: HTMLSpanElement;
  private readonly selectedColorRowNode: HTMLDivElement;
  private readonly selectedColorInputNode: HTMLInputElement;
  private readonly levelSelectNode: HTMLDivElement;
  private readonly levelSelectStatusNode: HTMLDivElement;
  private readonly levelSelectDropdown: HTMLSelectElement;
  private readonly levelRemoveButton: HTMLButtonElement;
  private readonly levelCreateInput: HTMLInputElement;
  private readonly levelCreateButton: HTMLButtonElement;
  private readonly levelSelectRefreshButton: HTMLButtonElement;

  private readonly controller: FpsController;
  private readonly worldStore = new LocalWorldStore(buildSeedWorld());
  private parentSphere = this.worldStore.getParentSphere();
  private parentMesh: THREE.Mesh | null = null;

  private readonly parentCenter = new THREE.Vector3(
    this.parentSphere.position3d[0],
    this.parentSphere.position3d[1],
    this.parentSphere.position3d[2],
  );

  private readonly player: PlayerBody = {
    position: new THREE.Vector3(0, -2.5, 16),
    velocity: new THREE.Vector3(),
    radius: PLAYER_RADIUS,
    grounded: false,
  };

  private readonly worldMeshes = new Map<string, THREE.Mesh>();
  private readonly obstacleMeshes = new Map<string, THREE.Mesh>();
  private readonly obstacleBodiesById = new Map<string, ObstacleBody>();
  private readonly multiplayerClient = new MultiplayerClient();
  private readonly remotePlayerRenderStates = new Map<string, RemotePlayerRenderState>();
  private readonly remotePlayerAvatars = new Map<string, RemoteAvatarRenderInstance>();
  private readonly avatarIdChoices = availableAvatarIds();
  private readonly templateIdChoices = [
    TEMPLATE_NONE_ID,
    ...getAvailableSubworldTemplateIds(),
  ];
  private readonly raycaster = new THREE.Raycaster();
  private obstacles: ObstacleBody[] = [];
  private unsubscribeWorldStore: (() => void) | null = null;
  private accumulatorSeconds = 0;
  private tick = 0;
  private lastCollisionCount = 0;
  private overlayEnabled = false;
  private editorMode = false;
  private createTemplateId = TEMPLATE_NONE_ID;
  private draggingSphereId: string | null = null;
  private dragDistance = CREATE_DISTANCE;
  private createdSphereCount = 0;
  private pendingCommitOperations: WorldCommitOperation[] = [];
  private saveInFlight = false;
  private saveMessage = "no pending edits";
  private backendWorldTick = 0;
  private readonly userId = this.getOrCreateUserId();
  private currentWorldId = DEFAULT_WORLD_ID;
  private availableWorldIds = [DEFAULT_WORLD_ID];
  private loadingWorldId: string | null = null;
  private levelMutationInFlight = false;
  private levelSelectMessage: string | null = null;
  private worldLoadVersion = 0;
  private localPlayerId: string | null = null;
  private multiplayerStatus = "disconnected";
  private multiplayerError: string | null = null;
  private selectedAvatarId: AvatarId = DEFAULT_AVATAR_ID;
  private lastNetworkSendTick = 0;
  private nextInputSequence = 0;
  private readonly pendingPredictedInputs = new Map<number, PredictedInputState>();
  private lastAckedInputSequence = 0;
  private lastSnapshotServerTick = 0;
  private lastReconciliationError = 0;
  private worldSourceState: "seed" | "loading" | "backend" | "backend-user" = "loading";
  private disposed = false;

  constructor(private readonly mountNode: HTMLDivElement) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.mountNode.appendChild(this.renderer.domElement);

    this.hudNode = document.createElement("div");
    this.hudNode.className = "hud";
    this.hudNode.hidden = true;
    this.mountNode.appendChild(this.hudNode);

    this.hintNode = document.createElement("div");
    this.hintNode.className = "center-hint";
    this.mountNode.appendChild(this.hintNode);

    this.crosshairNode = document.createElement("div");
    this.crosshairNode.className = "crosshair";
    this.mountNode.appendChild(this.crosshairNode);

    this.editorPanelsNode = document.createElement("div");
    this.editorPanelsNode.className = "editor-panels";
    this.mountNode.appendChild(this.editorPanelsNode);

    this.templateHudNode = document.createElement("div");
    this.templateHudNode.className = "template-hud";

    const templateTitle = document.createElement("div");
    templateTitle.className = "template-hud-title";
    templateTitle.textContent = "Template IDs (0 = none)";
    this.templateHudNode.appendChild(templateTitle);

    const createRow = document.createElement("div");
    createRow.className = "template-hud-row";
    const createLabel = document.createElement("span");
    createLabel.className = "template-hud-label";
    createLabel.textContent = "Create";
    createRow.appendChild(createLabel);

    this.createTemplateDecreaseButton = document.createElement("button");
    this.createTemplateDecreaseButton.type = "button";
    this.createTemplateDecreaseButton.textContent = "-";
    this.createTemplateDecreaseButton.addEventListener("click", () =>
      this.adjustCreateTemplateId(-1),
    );
    createRow.appendChild(this.createTemplateDecreaseButton);

    this.createTemplateValueNode = document.createElement("span");
    this.createTemplateValueNode.className = "template-hud-value";
    createRow.appendChild(this.createTemplateValueNode);

    this.createTemplateIncreaseButton = document.createElement("button");
    this.createTemplateIncreaseButton.type = "button";
    this.createTemplateIncreaseButton.textContent = "+";
    this.createTemplateIncreaseButton.addEventListener("click", () =>
      this.adjustCreateTemplateId(1),
    );
    createRow.appendChild(this.createTemplateIncreaseButton);
    this.templateHudNode.appendChild(createRow);

    const selectedRow = document.createElement("div");
    selectedRow.className = "template-hud-row";
    const selectedLabel = document.createElement("span");
    selectedLabel.className = "template-hud-label";
    selectedLabel.textContent = "Selected";
    selectedRow.appendChild(selectedLabel);

    this.selectedTemplateDecreaseButton = document.createElement("button");
    this.selectedTemplateDecreaseButton.type = "button";
    this.selectedTemplateDecreaseButton.textContent = "-";
    this.selectedTemplateDecreaseButton.addEventListener("click", () =>
      this.adjustSelectedTemplateId(-1),
    );
    selectedRow.appendChild(this.selectedTemplateDecreaseButton);

    this.selectedTemplateValueNode = document.createElement("span");
    this.selectedTemplateValueNode.className = "template-hud-value";
    selectedRow.appendChild(this.selectedTemplateValueNode);

    this.selectedTemplateIncreaseButton = document.createElement("button");
    this.selectedTemplateIncreaseButton.type = "button";
    this.selectedTemplateIncreaseButton.textContent = "+";
    this.selectedTemplateIncreaseButton.addEventListener("click", () =>
      this.adjustSelectedTemplateId(1),
    );
    selectedRow.appendChild(this.selectedTemplateIncreaseButton);
    this.templateHudNode.appendChild(selectedRow);

    const avatarRow = document.createElement("div");
    avatarRow.className = "template-hud-row";
    const avatarLabelNode = document.createElement("span");
    avatarLabelNode.className = "template-hud-label";
    avatarLabelNode.textContent = "Avatar";
    avatarRow.appendChild(avatarLabelNode);

    this.avatarDecreaseButton = document.createElement("button");
    this.avatarDecreaseButton.type = "button";
    this.avatarDecreaseButton.textContent = "-";
    this.avatarDecreaseButton.addEventListener("click", () =>
      this.adjustSelectedAvatarId(-1),
    );
    avatarRow.appendChild(this.avatarDecreaseButton);

    this.avatarValueNode = document.createElement("span");
    this.avatarValueNode.className = "template-hud-value";
    avatarRow.appendChild(this.avatarValueNode);

    this.avatarIncreaseButton = document.createElement("button");
    this.avatarIncreaseButton.type = "button";
    this.avatarIncreaseButton.textContent = "+";
    this.avatarIncreaseButton.addEventListener("click", () =>
      this.adjustSelectedAvatarId(1),
    );
    avatarRow.appendChild(this.avatarIncreaseButton);
    this.templateHudNode.appendChild(avatarRow);

    this.selectedColorRowNode = document.createElement("div");
    this.selectedColorRowNode.className = "template-hud-color-row";

    const selectedColorLabel = document.createElement("span");
    selectedColorLabel.className = "template-hud-label";
    selectedColorLabel.textContent = "Color";
    this.selectedColorRowNode.appendChild(selectedColorLabel);

    this.selectedColorInputNode = document.createElement("input");
    this.selectedColorInputNode.type = "color";
    this.selectedColorInputNode.className = "template-hud-color-input";
    this.selectedColorInputNode.value = this.encodeColorInputValue({
      r: DEFAULT_SPHERE_COLOR_RED,
      g: DEFAULT_SPHERE_COLOR_GREEN,
      b: DEFAULT_SPHERE_COLOR_BLUE,
    });
    this.selectedColorInputNode.addEventListener("input", this.onSelectedColorInput);
    this.selectedColorRowNode.appendChild(this.selectedColorInputNode);
    this.templateHudNode.appendChild(this.selectedColorRowNode);

    this.editorPanelsNode.appendChild(this.templateHudNode);

    this.levelSelectNode = document.createElement("div");
    this.levelSelectNode.className = "level-select";

    const levelSelectTitle = document.createElement("div");
    levelSelectTitle.className = "level-select-title";
    levelSelectTitle.textContent = "Level Select";
    this.levelSelectNode.appendChild(levelSelectTitle);

    this.levelSelectStatusNode = document.createElement("div");
    this.levelSelectStatusNode.className = "level-select-status";
    this.levelSelectNode.appendChild(this.levelSelectStatusNode);

    const levelSelectRow = document.createElement("div");
    levelSelectRow.className = "level-select-row";

    this.levelSelectDropdown = document.createElement("select");
    this.levelSelectDropdown.className = "level-select-dropdown";
    this.levelSelectDropdown.addEventListener("change", () => {
      void this.selectWorldLevel(this.levelSelectDropdown.value);
    });
    levelSelectRow.appendChild(this.levelSelectDropdown);

    this.levelRemoveButton = document.createElement("button");
    this.levelRemoveButton.type = "button";
    this.levelRemoveButton.className = "level-select-delete";
    this.levelRemoveButton.textContent = "Remove";
    this.levelRemoveButton.addEventListener("click", () => {
      void this.deleteWorldLevelById(this.levelSelectDropdown.value);
    });
    levelSelectRow.appendChild(this.levelRemoveButton);
    this.levelSelectNode.appendChild(levelSelectRow);

    const levelCreateRow = document.createElement("div");
    levelCreateRow.className = "level-select-create";

    this.levelCreateInput = document.createElement("input");
    this.levelCreateInput.className = "level-select-input";
    this.levelCreateInput.type = "text";
    this.levelCreateInput.placeholder = "new-level-id";
    this.levelCreateInput.autocomplete = "off";
    this.levelCreateInput.spellcheck = false;
    this.levelCreateInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      void this.createLevelFromInput();
    });
    levelCreateRow.appendChild(this.levelCreateInput);

    this.levelCreateButton = document.createElement("button");
    this.levelCreateButton.type = "button";
    this.levelCreateButton.className = "level-select-create-button";
    this.levelCreateButton.textContent = "Add";
    this.levelCreateButton.addEventListener("click", () => {
      void this.createLevelFromInput();
    });
    levelCreateRow.appendChild(this.levelCreateButton);
    this.levelSelectNode.appendChild(levelCreateRow);

    this.levelSelectRefreshButton = document.createElement("button");
    this.levelSelectRefreshButton.type = "button";
    this.levelSelectRefreshButton.className = "level-select-refresh";
    this.levelSelectRefreshButton.textContent = "Refresh";
    this.levelSelectRefreshButton.addEventListener("click", () => {
      void this.refreshAvailableWorldIds({ preserveCurrentWorldId: true });
    });
    this.levelSelectNode.appendChild(this.levelSelectRefreshButton);
    this.editorPanelsNode.appendChild(this.levelSelectNode);

    const queryWorldId = new URLSearchParams(window.location.search).get("world");
    if (queryWorldId && queryWorldId.trim().length > 0) {
      this.currentWorldId = queryWorldId.trim();
      this.availableWorldIds = [this.currentWorldId];
    }

    this.controller = new FpsController(this.renderer.domElement);

    this.setupScene();
    this.unsubscribeWorldStore = this.worldStore.subscribe(this.onWorldStoreChanged);
    this.updateHintText();
    this.updateTemplateHud();
    this.updateLevelSelectHud();
    this.recolorObstacles();
    void this.initializeLevelSelection();

    window.addEventListener("resize", this.onResize);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("wheel", this.onWheel, { passive: false });
    document.addEventListener("mousedown", this.onMouseDown);
    document.addEventListener("mouseup", this.onMouseUp);
    document.addEventListener("contextmenu", this.onContextMenu);
    window.addEventListener("blur", this.onWindowBlur);
  }

  start(): void {
    this.controller.connect();
    this.renderer.setAnimationLoop(this.animate);
    this.onResize();
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.controller.disconnect();
    this.renderer.setAnimationLoop(null);
    if (this.unsubscribeWorldStore) {
      this.unsubscribeWorldStore();
      this.unsubscribeWorldStore = null;
    }
    this.multiplayerClient.disconnect();
    this.clearRemotePlayers();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("wheel", this.onWheel);
    document.removeEventListener("mousedown", this.onMouseDown);
    document.removeEventListener("mouseup", this.onMouseUp);
    document.removeEventListener("contextmenu", this.onContextMenu);
    window.removeEventListener("blur", this.onWindowBlur);
    this.renderer.dispose();
  }

  private setupScene(): void {
    this.scene.background = new THREE.Color(0x090d15);
    this.scene.fog = new THREE.FogExp2(0x090d15, 0.0175);

    const ambientLight = new THREE.AmbientLight(0x9cbefc, 0.35);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xbad7ff, 1.0);
    keyLight.position.set(20, 45, 15);
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x7eb1ff, 0.3);
    rimLight.position.set(-24, 18, -12);
    this.scene.add(rimLight);

    const parentGeometry = new THREE.SphereGeometry(1, 48, 32);
    const parentMaterial = new THREE.MeshStandardMaterial({
      color: 0x2d3f58,
      roughness: 0.92,
      metalness: 0.05,
      side: THREE.BackSide,
      wireframe: true,
      transparent: true,
      opacity: 0.22,
    });

    const parentMesh = new THREE.Mesh(parentGeometry, parentMaterial);
    parentMesh.position.copy(this.parentCenter);
    parentMesh.scale.setScalar(this.parentSphere.radius);
    parentMesh.visible = this.editorMode;
    this.scene.add(parentMesh);
    this.parentMesh = parentMesh;

    this.syncObstaclesFromSnapshot(this.worldStore.getSnapshot());
  }

  private buildObstacleBody(
    entity: SphereEntity,
    portalHost: boolean,
    instancedSubworld: boolean,
    selectable: boolean = !entity.tags.includes("instanced-subworld"),
  ): ObstacleBody {
    return {
      id: entity.id,
      center: new THREE.Vector3(entity.position3d[0], entity.position3d[1], entity.position3d[2]),
      radius: entity.radius,
      money: entity.dimensions.money ?? 0,
      selectable,
      collidable: !portalHost,
      portalHost,
      instancedSubworld,
    };
  }

  private readonly onWorldStoreChanged = (snapshot: WorldStoreSnapshot): void => {
    if (
      this.draggingSphereId !== null &&
      !snapshot.children.some((child) => child.id === this.draggingSphereId)
    ) {
      this.stopDraggingSphere();
    }

    this.parentSphere = snapshot.parent;
    this.parentCenter.set(
      snapshot.parent.position3d[0],
      snapshot.parent.position3d[1],
      snapshot.parent.position3d[2],
    );
    if (this.parentMesh) {
      this.parentMesh.position.copy(this.parentCenter);
      this.parentMesh.scale.setScalar(this.parentSphere.radius);
    }
    this.syncObstaclesFromSnapshot(snapshot);
    this.updateTemplateHud();
  };

  private async initializeLevelSelection(): Promise<void> {
    await this.refreshAvailableWorldIds({ preserveCurrentWorldId: true });
    await this.selectWorldLevel(this.currentWorldId, true);
  }

  private normalizeWorldIds(worldIds: string[]): string[] {
    const normalizedWorldIds: string[] = [];
    const seenWorldIds = new Set<string>();

    for (const value of worldIds) {
      const worldId = value.trim();
      if (worldId.length === 0 || seenWorldIds.has(worldId)) {
        continue;
      }

      seenWorldIds.add(worldId);
      normalizedWorldIds.push(worldId);
    }

    return normalizedWorldIds;
  }

  private isLevelSelectBusy(): boolean {
    return this.loadingWorldId !== null || this.saveInFlight || this.levelMutationInFlight;
  }

  private async refreshAvailableWorldIds(options: {
    preserveCurrentWorldId: boolean;
  }): Promise<void> {
    const { preserveCurrentWorldId } = options;
    const fallbackWorldIds = [...this.availableWorldIds];
    this.levelSelectRefreshButton.disabled = true;

    try {
      const fetchedWorldIds = await fetchAvailableWorldIds();
      if (this.disposed) {
        return;
      }

      const normalizedWorldIds = this.normalizeWorldIds(fetchedWorldIds);
      this.availableWorldIds =
        normalizedWorldIds.length > 0 ? normalizedWorldIds : this.normalizeWorldIds(fallbackWorldIds);
    } catch (error) {
      console.warn("Failed to fetch world list", error);
      this.availableWorldIds = this.normalizeWorldIds(fallbackWorldIds);
      this.levelSelectMessage =
        error instanceof Error ? `level refresh failed: ${error.message}` : "level refresh failed";
    } finally {
      if (!this.disposed) {
        this.availableWorldIds = preserveCurrentWorldId
          ? this.normalizeWorldIds([this.currentWorldId, ...this.availableWorldIds])
          : this.normalizeWorldIds(this.availableWorldIds);
        this.updateLevelSelectHud();
      }
    }
  }

  private async createLevelFromInput(): Promise<void> {
    if (this.isLevelSelectBusy()) {
      return;
    }

    const requestedWorldId = this.levelCreateInput.value.trim();
    if (requestedWorldId.length === 0) {
      this.levelSelectMessage = "enter a level id";
      this.updateLevelSelectHud();
      return;
    }

    this.levelMutationInFlight = true;
    this.levelSelectMessage = `creating "${requestedWorldId}"...`;
    this.updateLevelSelectHud();

    try {
      const createdWorldId = await createWorldLevel(requestedWorldId);
      if (this.disposed) {
        return;
      }

      this.levelCreateInput.value = "";
      this.levelSelectMessage = `created "${createdWorldId}"`;
      await this.refreshAvailableWorldIds({ preserveCurrentWorldId: true });
      await this.selectWorldLevel(createdWorldId, true);
    } catch (error) {
      if (this.disposed) {
        return;
      }

      this.levelSelectMessage =
        error instanceof Error ? `create failed: ${error.message}` : "create failed";
    } finally {
      if (!this.disposed) {
        this.levelMutationInFlight = false;
        this.updateLevelSelectHud();
      }
    }
  }

  private async deleteWorldLevelById(worldId: string): Promise<void> {
    if (this.isLevelSelectBusy()) {
      return;
    }

    if (this.availableWorldIds.length <= 1) {
      this.levelSelectMessage = "cannot remove the last level";
      this.updateLevelSelectHud();
      return;
    }

    if (!window.confirm(`Delete level "${worldId}"?`)) {
      return;
    }

    const deletingCurrentWorld = worldId === this.currentWorldId;
    this.levelMutationInFlight = true;
    this.levelSelectMessage = `removing "${worldId}"...`;
    this.updateLevelSelectHud();

    try {
      await deleteWorldLevel(worldId);
      if (this.disposed) {
        return;
      }

      this.levelSelectMessage = `removed "${worldId}"`;
      await this.refreshAvailableWorldIds({
        preserveCurrentWorldId: !deletingCurrentWorld,
      });

      if (deletingCurrentWorld) {
        const nextWorldId = this.availableWorldIds[0] ?? DEFAULT_WORLD_ID;
        await this.selectWorldLevel(nextWorldId, true);
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }

      this.levelSelectMessage =
        error instanceof Error ? `remove failed: ${error.message}` : "remove failed";
    } finally {
      if (!this.disposed) {
        this.levelMutationInFlight = false;
        this.updateLevelSelectHud();
      }
    }
  }

  private updateWorldQueryParam(worldId: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set("world", worldId);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  private async selectWorldLevel(worldIdInput: string, force: boolean = false): Promise<void> {
    const worldId = worldIdInput.trim();
    if (worldId.length === 0) {
      return;
    }

    if (!force && worldId === this.currentWorldId && this.loadingWorldId === null) {
      return;
    }

    const requestVersion = this.worldLoadVersion + 1;
    this.worldLoadVersion = requestVersion;
    this.loadingWorldId = worldId;
    this.currentWorldId = worldId;
    this.levelSelectMessage = null;
    this.availableWorldIds = this.normalizeWorldIds([worldId, ...this.availableWorldIds]);
    this.pendingCommitOperations = [];
    this.refreshPendingSaveMessage();
    this.saveMessage = `loading level "${worldId}"...`;
    this.stopDraggingSphere();
    this.worldStore.apply({ type: "deselectSphere" });
    this.updateWorldQueryParam(worldId);
    this.updateLevelSelectHud();
    this.connectMultiplayer(worldId);

    await this.loadWorldFromBackend(worldId, requestVersion);
    if (this.disposed || requestVersion !== this.worldLoadVersion) {
      return;
    }

    this.loadingWorldId = null;
    this.movePlayerToCurrentWorld();
    this.updateLevelSelectHud();
  }

  private updateLevelSelectHud(): void {
    this.levelSelectNode.hidden = !this.editorMode;
    if (!this.editorMode) {
      return;
    }

    if (this.loadingWorldId) {
      this.levelSelectStatusNode.textContent = `Loading "${this.loadingWorldId}"...`;
    } else if (this.levelMutationInFlight) {
      this.levelSelectStatusNode.textContent = "Updating levels...";
    } else if (this.levelSelectMessage) {
      this.levelSelectStatusNode.textContent = this.levelSelectMessage;
    } else {
      this.levelSelectStatusNode.textContent = `Current: ${this.currentWorldId}`;
    }

    const controlsDisabled = this.isLevelSelectBusy();
    this.levelCreateInput.disabled = controlsDisabled;
    this.levelCreateButton.disabled = controlsDisabled;
    const selectedWorldId = this.availableWorldIds.includes(this.currentWorldId)
      ? this.currentWorldId
      : (this.availableWorldIds[0] ?? "");
    this.levelSelectDropdown.textContent = "";
    for (const worldId of this.availableWorldIds) {
      const option = document.createElement("option");
      option.value = worldId;
      option.textContent = worldId;
      this.levelSelectDropdown.appendChild(option);
    }
    this.levelSelectDropdown.value = selectedWorldId;
    this.levelSelectDropdown.disabled = controlsDisabled || this.availableWorldIds.length === 0;
    this.levelRemoveButton.disabled = controlsDisabled || this.availableWorldIds.length <= 1;

    this.levelSelectRefreshButton.disabled = controlsDisabled;
  }

  private async loadWorldFromBackend(worldId: string, requestVersion: number): Promise<void> {
    this.worldSourceState = "loading";
    this.updateLevelSelectHud();

    try {
      const loadedWorld = await fetchWorldSeed(worldId, this.userId);
      if (this.disposed || requestVersion !== this.worldLoadVersion) {
        return;
      }

      const hydrated = this.worldStore.apply({
        type: "hydrateWorld",
        world: loadedWorld.world,
      });

      this.backendWorldTick = loadedWorld.tick;
      this.pendingCommitOperations = [];
      this.refreshPendingSaveMessage();
      this.worldSourceState = hydrated ? "backend" : "seed";
      this.levelSelectMessage = null;
      this.saveMessage = `loaded level "${worldId}"`;
    } catch (error) {
      if (this.disposed || requestVersion !== this.worldLoadVersion) {
        return;
      }

      this.worldStore.apply({
        type: "hydrateWorld",
        world: buildSeedWorld(),
      });
      this.backendWorldTick = 0;
      this.pendingCommitOperations = [];
      this.refreshPendingSaveMessage();
      this.worldSourceState = "seed";
      this.levelSelectMessage = `load failed for "${worldId}"`;
      this.saveMessage = `load failed for "${worldId}", using seed fallback`;
      console.warn("Failed to load world from backend, using local seed world", error);
    }
  }

  private refreshPendingSaveMessage(): void {
    if (this.saveInFlight) {
      return;
    }

    if (this.pendingCommitOperations.length === 0) {
      this.saveMessage = "no pending edits";
      return;
    }

    this.saveMessage = `pending edits: ${this.pendingCommitOperations.length}`;
  }

  private async saveWorldCommit(): Promise<void> {
    if (this.saveInFlight) {
      return;
    }

    if (this.pendingCommitOperations.length === 0) {
      this.saveMessage = "no pending edits";
      return;
    }

    this.saveInFlight = true;
    this.saveMessage = `saving ${this.pendingCommitOperations.length} edit(s)...`;
    this.updateLevelSelectHud();

    try {
      const response = await commitWorldChanges({
        worldId: this.currentWorldId,
        userId: this.userId,
        baseTick: this.backendWorldTick,
        operations: this.pendingCommitOperations,
      });

      this.worldStore.apply({
        type: "hydrateWorld",
        world: response.world,
      });

      this.backendWorldTick = response.tick;
      this.pendingCommitOperations = [];
      this.worldSourceState = response.savedTo === "master" ? "backend" : "backend-user";
      const reasonSuffix = response.reason ? ` (${response.reason})` : "";
      this.saveMessage = `saved ${response.commitId} -> ${response.savedTo}${reasonSuffix}`;
    } catch (error) {
      if (error instanceof WorldCommitError) {
        if (error.validationErrors.length > 0) {
          this.saveMessage = `save failed: ${error.validationErrors[0]}`;
        } else {
          this.saveMessage = `save failed: ${error.message}`;
        }
      } else if (error instanceof Error) {
        this.saveMessage = `save failed: ${error.message}`;
      } else {
        this.saveMessage = "save failed: unknown error";
      }
    } finally {
      this.saveInFlight = false;
      this.updateLevelSelectHud();
    }
  }

  private getOrCreateUserId(): string {
    const storageKey = "fpsphere.user_id";

    try {
      const existing = window.localStorage.getItem(storageKey);
      if (existing && existing.length > 0) {
        return existing;
      }

      const generated =
        typeof window.crypto?.randomUUID === "function"
          ? window.crypto.randomUUID()
          : `user-${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(storageKey, generated);
      return generated;
    } catch {
      return "user-local-fallback";
    }
  }

  private updatePendingCreateSphere(
    sphereId: string,
    update: (sphere: SphereEntity) => void,
  ): boolean {
    for (const operation of this.pendingCommitOperations) {
      if (operation.type !== "create" || operation.sphere.id !== sphereId) {
        continue;
      }

      update(operation.sphere);
      return true;
    }

    return false;
  }

  private queueCreateSphereOperation(sphere: SphereEntity): void {
    const alreadyQueued = this.pendingCommitOperations.some(
      (operation) => operation.type === "create" && operation.sphere.id === sphere.id,
    );
    if (alreadyQueued) {
      return;
    }

    this.pendingCommitOperations.push({
      type: "create",
      sphere: {
        id: sphere.id,
        parentId: sphere.parentId,
        radius: sphere.radius,
        position3d: [...sphere.position3d],
        dimensions: { ...sphere.dimensions },
        timeWindow: { ...sphere.timeWindow },
        tags: [...sphere.tags],
      },
    });
  }

  private queueMoveOperation(sphereId: string, position3d: [number, number, number]): void {
    if (
      this.updatePendingCreateSphere(sphereId, (sphere) => {
        sphere.position3d = [...position3d];
      })
    ) {
      return;
    }

    for (let index = this.pendingCommitOperations.length - 1; index >= 0; index -= 1) {
      const operation = this.pendingCommitOperations[index];
      if (operation.type === "move" && operation.sphereId === sphereId) {
        operation.position3d = [...position3d];
        return;
      }
    }

    this.pendingCommitOperations.push({
      type: "move",
      sphereId,
      position3d: [...position3d],
    });
  }

  private queueUpdateRadiusOperation(sphereId: string, radius: number): void {
    if (
      this.updatePendingCreateSphere(sphereId, (sphere) => {
        sphere.radius = radius;
      })
    ) {
      return;
    }

    for (let index = this.pendingCommitOperations.length - 1; index >= 0; index -= 1) {
      const operation = this.pendingCommitOperations[index];
      if (operation.type === "updateRadius" && operation.sphereId === sphereId) {
        operation.radius = radius;
        return;
      }
    }

    this.pendingCommitOperations.push({
      type: "updateRadius",
      sphereId,
      radius,
    });
  }

  private queueUpdateDimensionsOperation(
    sphereId: string,
    dimensions: Record<string, number>,
  ): void {
    if (
      this.updatePendingCreateSphere(sphereId, (sphere) => {
        sphere.dimensions = {
          ...sphere.dimensions,
          ...dimensions,
        };
      })
    ) {
      return;
    }

    for (let index = this.pendingCommitOperations.length - 1; index >= 0; index -= 1) {
      const operation = this.pendingCommitOperations[index];
      if (operation.type === "updateDimensions" && operation.sphereId === sphereId) {
        operation.dimensions = {
          ...operation.dimensions,
          ...dimensions,
        };
        return;
      }
    }

    this.pendingCommitOperations.push({
      type: "updateDimensions",
      sphereId,
      dimensions: { ...dimensions },
    });
  }

  private readNormalizedColorChannel(value: unknown, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }

    return Math.max(0, Math.min(1, value));
  }

  private readSphereColorChannels(entity: SphereEntity | null): SphereColorChannels {
    return {
      r: this.readNormalizedColorChannel(
        entity?.dimensions[SPHERE_COLOR_RED_DIMENSION],
        DEFAULT_SPHERE_COLOR_RED,
      ),
      g: this.readNormalizedColorChannel(
        entity?.dimensions[SPHERE_COLOR_GREEN_DIMENSION],
        DEFAULT_SPHERE_COLOR_GREEN,
      ),
      b: this.readNormalizedColorChannel(
        entity?.dimensions[SPHERE_COLOR_BLUE_DIMENSION],
        DEFAULT_SPHERE_COLOR_BLUE,
      ),
    };
  }

  private getDefaultColorDimensions(): Record<string, number> {
    return {
      [SPHERE_COLOR_RED_DIMENSION]: DEFAULT_SPHERE_COLOR_RED,
      [SPHERE_COLOR_GREEN_DIMENSION]: DEFAULT_SPHERE_COLOR_GREEN,
      [SPHERE_COLOR_BLUE_DIMENSION]: DEFAULT_SPHERE_COLOR_BLUE,
    };
  }

  private setObstacleMeshColorChannels(
    obstacleMesh: THREE.Mesh,
    colorChannels: SphereColorChannels,
  ): void {
    obstacleMesh.userData.colorR = colorChannels.r;
    obstacleMesh.userData.colorG = colorChannels.g;
    obstacleMesh.userData.colorB = colorChannels.b;
  }

  private readObstacleMeshColorChannels(obstacleMesh: THREE.Mesh): SphereColorChannels {
    return {
      r: this.readNormalizedColorChannel(obstacleMesh.userData.colorR, DEFAULT_SPHERE_COLOR_RED),
      g: this.readNormalizedColorChannel(obstacleMesh.userData.colorG, DEFAULT_SPHERE_COLOR_GREEN),
      b: this.readNormalizedColorChannel(obstacleMesh.userData.colorB, DEFAULT_SPHERE_COLOR_BLUE),
    };
  }

  private encodeColorInputValue(colorChannels: SphereColorChannels): string {
    return `#${new THREE.Color(colorChannels.r, colorChannels.g, colorChannels.b).getHexString()}`;
  }

  private parseColorInputValue(inputValue: string): SphereColorChannels | null {
    if (!/^#[\da-fA-F]{6}$/.test(inputValue)) {
      return null;
    }

    const hex = Number.parseInt(inputValue.slice(1), 16);
    return {
      r: Number((((hex >> 16) & 0xff) / 255).toFixed(4)),
      g: Number((((hex >> 8) & 0xff) / 255).toFixed(4)),
      b: Number(((hex & 0xff) / 255).toFixed(4)),
    };
  }

  private toColorDimensions(colorChannels: SphereColorChannels): Record<string, number> {
    return {
      [SPHERE_COLOR_RED_DIMENSION]: colorChannels.r,
      [SPHERE_COLOR_GREEN_DIMENSION]: colorChannels.g,
      [SPHERE_COLOR_BLUE_DIMENSION]: colorChannels.b,
    };
  }

  private getSelectedEditableSphere(): SphereEntity | null {
    const selectedSphereId = this.worldStore.getSelectedSphereId();
    if (!selectedSphereId) {
      return null;
    }

    return this.worldStore.getChildSphereById(selectedSphereId);
  }

  private readTemplateId(entity: SphereEntity | null): number {
    if (!entity) {
      return TEMPLATE_NONE_ID;
    }

    const value = entity.dimensions[SUBWORLD_TEMPLATE_DIMENSION];
    if (!Number.isFinite(value)) {
      return TEMPLATE_NONE_ID;
    }

    return Math.max(TEMPLATE_NONE_ID, Math.trunc(value));
  }

  private isTemplateRootSphere(entity: SphereEntity): boolean {
    return entity.tags.includes(TEMPLATE_ROOT_TAG);
  }

  private getTemplateRootSphere(templateId: number): SphereEntity | null {
    if (templateId <= TEMPLATE_NONE_ID) {
      return null;
    }

    return this.worldStore.getSphereById(getTemplateRootSphereId(templateId));
  }

  private hasSharedTemplateDefinition(templateId: number): boolean {
    const templateRoot = this.getTemplateRootSphere(templateId);
    if (!templateRoot) {
      return false;
    }

    return this.worldStore.listChildrenOf(templateRoot.id).length > 0;
  }

  private resolveTemplateHostScale(hostSphere: SphereEntity, templateRootRadius: number): number {
    if (!Number.isFinite(templateRootRadius) || templateRootRadius <= 0) {
      return 0;
    }

    const baseScale = hostSphere.radius / templateRootRadius;
    if (!Number.isFinite(baseScale) || baseScale <= 0) {
      return 0;
    }

    const dimensionScale = hostSphere.dimensions[SUBWORLD_SCALE_DIMENSION];
    const extraScale = Number.isFinite(dimensionScale) && dimensionScale > 0 ? dimensionScale : 1;

    return baseScale * extraScale;
  }

  private ensureTemplateRootSphere(templateId: number): SphereEntity | null {
    const existing = this.getTemplateRootSphere(templateId);
    if (existing) {
      return existing;
    }

    const rootWorld = this.worldStore.getRootSphere();
    const templateRoot: SphereEntity = {
      id: getTemplateRootSphereId(templateId),
      parentId: rootWorld.id,
      radius: getTemplateRootRadius(templateId),
      position3d: [...rootWorld.position3d],
      dimensions: {
        money: 0,
        [SUBWORLD_TEMPLATE_DIMENSION]: templateId,
        [SUBWORLD_SCALE_DIMENSION]: 1,
        ...this.getDefaultColorDimensions(),
      },
      timeWindow: {
        start: this.tick,
        end: null,
      },
      tags: [TEMPLATE_ROOT_TAG, `template-${templateId}`],
    };

    const created = this.worldStore.apply({
      type: "createSphere",
      sphere: templateRoot,
    });
    if (!created) {
      return this.getTemplateRootSphere(templateId);
    }

    this.queueCreateSphereOperation(templateRoot);
    this.refreshPendingSaveMessage();
    return templateRoot;
  }

  private seedSharedTemplateDefinitionIfNeeded(
    templateRoot: SphereEntity,
    sourceHost: SphereEntity,
  ): void {
    if (this.worldStore.listChildrenOf(templateRoot.id).length > 0) {
      return;
    }

    const hostScale = this.resolveTemplateHostScale(sourceHost, templateRoot.radius);
    const legacyChildren = this.worldStore
      .listChildrenOf(sourceHost.id)
      .filter((child) => !child.tags.includes("instanced-subworld"));

    const nextChildren: SphereEntity[] = [];
    if (legacyChildren.length > 0 && hostScale > 0) {
      for (const legacyChild of legacyChildren) {
        nextChildren.push({
          id: `${templateRoot.id}::from-${legacyChild.id}`,
          parentId: templateRoot.id,
          radius: Math.max(0.05, legacyChild.radius / hostScale),
          position3d: [
            templateRoot.position3d[0] + (legacyChild.position3d[0] - sourceHost.position3d[0]) / hostScale,
            templateRoot.position3d[1] + (legacyChild.position3d[1] - sourceHost.position3d[1]) / hostScale,
            templateRoot.position3d[2] + (legacyChild.position3d[2] - sourceHost.position3d[2]) / hostScale,
          ],
          dimensions: { ...legacyChild.dimensions },
          timeWindow: { ...legacyChild.timeWindow },
          tags: [
            ...legacyChild.tags.filter(
              (tag) =>
                tag !== "instanced-subworld" &&
                tag !== TEMPLATE_ROOT_TAG &&
                !tag.startsWith("template-"),
            ),
            TEMPLATE_DEFINITION_TAG,
          ],
        });
      }
    } else {
      const sourceTemplateId = this.readTemplateId(sourceHost);
      const seedTemplateId = resolveTemplateSeedId(sourceTemplateId);
      if (seedTemplateId === null) {
        return;
      }

      const seedHost: SphereEntity = {
        ...templateRoot,
        dimensions: {
          ...templateRoot.dimensions,
          [SUBWORLD_TEMPLATE_DIMENSION]: seedTemplateId,
          [SUBWORLD_SCALE_DIMENSION]: 1,
        },
      };
      for (const child of instantiateSubworldChildren([seedHost])) {
        nextChildren.push({
          ...child,
          tags: [
            ...child.tags.filter(
              (tag) => tag !== "instanced-subworld" && !tag.startsWith("template-"),
            ),
            TEMPLATE_DEFINITION_TAG,
          ],
        });
      }
    }

    let createdCount = 0;
    for (const child of nextChildren) {
      const created = this.worldStore.apply({
        type: "createSphere",
        sphere: child,
      });
      if (!created) {
        continue;
      }

      this.queueCreateSphereOperation(child);
      createdCount += 1;
    }

    if (createdCount > 0) {
      this.refreshPendingSaveMessage();
    }
  }

  private instantiateSharedTemplateChildren(hostSpheres: SphereEntity[]): SphereEntity[] {
    const derived: SphereEntity[] = [];

    for (const hostSphere of hostSpheres) {
      const templateId = this.readTemplateId(hostSphere);
      if (templateId <= TEMPLATE_NONE_ID) {
        continue;
      }

      const templateRoot = this.getTemplateRootSphere(templateId);
      if (!templateRoot) {
        continue;
      }

      const templateChildren = this.worldStore.listChildrenOf(templateRoot.id);
      if (templateChildren.length === 0) {
        continue;
      }

      const hostScale = this.resolveTemplateHostScale(hostSphere, templateRoot.radius);
      if (hostScale <= 0) {
        continue;
      }

      for (const templateChild of templateChildren) {
        const offsetX = templateChild.position3d[0] - templateRoot.position3d[0];
        const offsetY = templateChild.position3d[1] - templateRoot.position3d[1];
        const offsetZ = templateChild.position3d[2] - templateRoot.position3d[2];

        derived.push({
          id: `${hostSphere.id}::template-${templateId}::entity-${templateChild.id}`,
          parentId: hostSphere.id,
          radius: Math.max(0.05, templateChild.radius * hostScale),
          position3d: [
            hostSphere.position3d[0] + offsetX * hostScale,
            hostSphere.position3d[1] + offsetY * hostScale,
            hostSphere.position3d[2] + offsetZ * hostScale,
          ],
          dimensions: { ...templateChild.dimensions },
          timeWindow: { ...hostSphere.timeWindow },
          tags: [
            ...templateChild.tags.filter(
              (tag) =>
                tag !== TEMPLATE_DEFINITION_TAG &&
                tag !== TEMPLATE_ROOT_TAG &&
                tag !== "instanced-subworld",
            ),
            "instanced-subworld",
            `template-${templateId}`,
          ],
        });
      }
    }

    return derived;
  }

  private getCreateTemplateMaxId(): number {
    let maxTemplateId = this.templateIdChoices[this.templateIdChoices.length - 1] ?? TEMPLATE_NONE_ID;

    const root = this.worldStore.getRootSphere();
    maxTemplateId = Math.max(maxTemplateId, this.readTemplateId(root));
    for (const sphere of this.worldStore.listDescendantsOf(root.id)) {
      maxTemplateId = Math.max(maxTemplateId, this.readTemplateId(sphere));
    }

    return maxTemplateId;
  }

  private stepTemplateId(
    currentTemplateId: number,
    delta: number,
    allowBeyondKnownChoices: boolean = false,
  ): number {
    const base = Number.isFinite(currentTemplateId)
      ? Math.max(TEMPLATE_NONE_ID, Math.trunc(currentTemplateId))
      : TEMPLATE_NONE_ID;
    const step = delta < 0 ? -1 : 1;
    const nextId = Math.max(TEMPLATE_NONE_ID, base + step);

    if (allowBeyondKnownChoices) {
      return nextId;
    }

    return Math.min(this.getCreateTemplateMaxId(), nextId);
  }

  private adjustCreateTemplateId(delta: number): void {
    this.createTemplateId = this.stepTemplateId(this.createTemplateId, delta);
    this.updateTemplateHud();
  }

  private adjustSelectedTemplateId(delta: number): void {
    if (!this.editorMode) {
      return;
    }

    const selectedSphere = this.getSelectedEditableSphere();
    if (!selectedSphere) {
      return;
    }

    const currentTemplateId = this.readTemplateId(selectedSphere);
    const nextTemplateId = this.stepTemplateId(currentTemplateId, delta, true);
    if (nextTemplateId === currentTemplateId) {
      return;
    }

    const changed = this.worldStore.apply({
      type: "updateSphereDimensions",
      sphereId: selectedSphere.id,
      dimensions: {
        [SUBWORLD_TEMPLATE_DIMENSION]: nextTemplateId,
      },
    });

    if (!changed) {
      return;
    }

    this.queueUpdateDimensionsOperation(selectedSphere.id, {
      [SUBWORLD_TEMPLATE_DIMENSION]: nextTemplateId,
    });
    this.refreshPendingSaveMessage();
    this.updateTemplateHud();
  }

  private stepAvatarId(currentAvatarId: AvatarId, delta: number): AvatarId {
    if (this.avatarIdChoices.length === 0) {
      return DEFAULT_AVATAR_ID;
    }

    const currentIndex = this.avatarIdChoices.indexOf(currentAvatarId);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex =
      (safeIndex + (delta < 0 ? -1 : 1) + this.avatarIdChoices.length) %
      this.avatarIdChoices.length;
    return this.avatarIdChoices[nextIndex];
  }

  private adjustSelectedAvatarId(delta: number): void {
    if (!this.editorMode) {
      return;
    }

    const nextAvatarId = this.stepAvatarId(this.selectedAvatarId, delta);
    if (nextAvatarId === this.selectedAvatarId) {
      return;
    }

    this.selectedAvatarId = nextAvatarId;
    this.updateTemplateHud();
    if (this.localPlayerId) {
      this.sendLocalPlayerUpdate({ recordPrediction: false });
    }
  }

  private updateTemplateHud(): void {
    const selectedSphere = this.getSelectedEditableSphere();
    const selectedTemplateId = this.readTemplateId(selectedSphere);
    const selectedSphereColor = this.readSphereColorChannels(selectedSphere);

    this.templateHudNode.hidden = !this.editorMode;
    this.templateHudNode.classList.toggle("template-hud-disabled", !this.editorMode);
    this.createTemplateValueNode.textContent = `${this.createTemplateId}`;
    this.selectedTemplateValueNode.textContent = selectedSphere
      ? `${selectedTemplateId}`
      : "none";
    this.avatarValueNode.textContent = avatarLabel(this.selectedAvatarId);

    const createEnabled = this.editorMode;
    const selectedEnabled = this.editorMode && selectedSphere !== null;

    this.createTemplateDecreaseButton.disabled = !createEnabled;
    this.createTemplateIncreaseButton.disabled = !createEnabled;
    this.selectedTemplateDecreaseButton.disabled = !selectedEnabled;
    this.selectedTemplateIncreaseButton.disabled = !selectedEnabled;
    this.avatarDecreaseButton.disabled = !createEnabled;
    this.avatarIncreaseButton.disabled = !createEnabled;
    this.selectedColorRowNode.hidden = !selectedEnabled;
    this.selectedColorInputNode.disabled = !selectedEnabled;
    this.selectedColorInputNode.value = this.encodeColorInputValue(selectedSphereColor);
  }

  private movePlayerToCurrentWorld(): void {
    const radius = this.parentSphere.radius;
    const minOffset = PLAYER_RADIUS + 0.75;
    const maxOffset = Math.max(minOffset, radius - PLAYER_RADIUS - 0.75);
    const depthOffset = Math.min(Math.max(radius * 0.25, minOffset), maxOffset);

    this.player.position.set(
      this.parentCenter.x,
      this.parentCenter.y - Math.min(2, radius * 0.18),
      this.parentCenter.z + depthOffset,
    );
    this.player.velocity.set(0, 0, 0);
  }

  private handleEnterOrExitWorldShortcut(): void {
    const selectedSphere = this.getSelectedEditableSphere();
    if (selectedSphere) {
      const templateId = this.readTemplateId(selectedSphere);
      if (templateId > TEMPLATE_NONE_ID) {
        const templateRoot = this.ensureTemplateRootSphere(templateId);
        if (!templateRoot) {
          return;
        }
        this.seedSharedTemplateDefinitionIfNeeded(templateRoot, selectedSphere);

        const entered = this.worldStore.apply({
          type: "enterSphere",
          sphereId: templateRoot.id,
        });
        if (entered) {
          this.createTemplateId = TEMPLATE_NONE_ID;
          this.stopDraggingSphere();
          this.movePlayerToCurrentWorld();
          this.updateTemplateHud();
        }
        return;
      }
    }

    const exited = this.worldStore.apply({ type: "exitSphere" });
    if (exited) {
      this.stopDraggingSphere();
      this.movePlayerToCurrentWorld();
    }
  }

  private stopDraggingSphere(): void {
    this.draggingSphereId = null;
  }

  private updateDraggedSphere(orientation: { yaw: number; pitch: number }): void {
    if (!this.editorMode || !this.draggingSphereId) {
      return;
    }

    const sphereId = this.draggingSphereId;
    const selectedSphereId = this.worldStore.getSelectedSphereId();
    if (selectedSphereId !== sphereId) {
      this.stopDraggingSphere();
      return;
    }

    const sphere = this.worldStore.getChildSphereById(sphereId);
    if (!sphere) {
      this.stopDraggingSphere();
      return;
    }

    tempLookEuler.set(orientation.pitch, orientation.yaw, 0, "YXZ");
    tempForward.set(0, 0, -1).applyEuler(tempLookEuler).normalize();
    tempDragTarget.copy(this.player.position).addScaledVector(tempForward, this.dragDistance);

    tempOffset.copy(tempDragTarget).sub(this.parentCenter);
    const distanceFromCenter = tempOffset.length();
    const maxDistance = Math.max(
      DRAG_MIN_DISTANCE,
      this.parentSphere.radius - sphere.radius - CREATE_BOUNDARY_MARGIN,
    );
    if (distanceFromCenter > maxDistance) {
      if (distanceFromCenter > 1e-6) {
        tempDragTarget
          .copy(this.parentCenter)
          .addScaledVector(tempOffset.normalize(), maxDistance);
      } else {
        tempDragTarget.set(
          this.parentCenter.x,
          this.parentCenter.y,
          this.parentCenter.z + maxDistance,
        );
      }
    }

    const nextPosition: [number, number, number] = [
      Number(tempDragTarget.x.toFixed(3)),
      Number(tempDragTarget.y.toFixed(3)),
      Number(tempDragTarget.z.toFixed(3)),
    ];

    const changed = this.worldStore.apply({
      type: "updateSpherePosition",
      sphereId,
      position3d: nextPosition,
    });
    if (!changed) {
      return;
    }

    this.queueMoveOperation(sphereId, nextPosition);
    this.refreshPendingSaveMessage();
  }

  private syncObstaclesFromSnapshot(snapshot: WorldStoreSnapshot): void {
    const rootView = snapshot.parent.parentId === null;
    const visibleChildren = rootView
      ? snapshot.children.filter((child) => !this.isTemplateRootSphere(child))
      : snapshot.children;
    const templateHosts = rootView
      ? [snapshot.parent, ...visibleChildren]
      : [...visibleChildren];
    const expandedChildren: SphereEntity[] = [];
    const expandedIds = new Set<string>();

    const pushExpanded = (entity: SphereEntity): void => {
      if (expandedIds.has(entity.id)) {
        return;
      }
      expandedChildren.push(entity);
      expandedIds.add(entity.id);
    };

    for (const child of visibleChildren) {
      pushExpanded(child);
    }

    for (const child of visibleChildren) {
      const templateId = this.readTemplateId(child);
      if (templateId > TEMPLATE_NONE_ID && this.hasSharedTemplateDefinition(templateId)) {
        continue;
      }
      for (const descendant of this.worldStore.listDescendantsOf(child.id)) {
        pushExpanded(descendant);
      }
    }

    for (const instancedChild of this.instantiateSharedTemplateChildren(templateHosts)) {
      pushExpanded(instancedChild);
    }

    const fallbackTemplateHosts = templateHosts.filter((host) => {
      const templateId = this.readTemplateId(host);
      return templateId > TEMPLATE_NONE_ID && !this.hasSharedTemplateDefinition(templateId);
    });

    for (const instancedChild of instantiateSubworldChildren(fallbackTemplateHosts)) {
      pushExpanded(instancedChild);
    }

    const nextIds = new Set<string>();

    for (const entity of expandedChildren) {
      nextIds.add(entity.id);
      const instancedSubworld = entity.tags.includes("instanced-subworld");
      const templateId = entity.dimensions[SUBWORLD_TEMPLATE_DIMENSION];
      const colorChannels = this.readSphereColorChannels(entity);
      const portalHost =
        entity.parentId === snapshot.parent.id &&
        Number.isFinite(templateId) &&
        Math.trunc(templateId) > TEMPLATE_NONE_ID;
      const selectable =
        entity.parentId === snapshot.parent.id &&
        !instancedSubworld &&
        !this.isTemplateRootSphere(entity);

      const existingBody = this.obstacleBodiesById.get(entity.id);
      if (!existingBody) {
        const body = this.buildObstacleBody(
          entity,
          portalHost,
          instancedSubworld,
          selectable,
        );
        this.obstacleBodiesById.set(entity.id, body);
        this.addObstacleMesh(body, colorChannels);
        continue;
      }

      existingBody.center.set(entity.position3d[0], entity.position3d[1], entity.position3d[2]);
      existingBody.radius = entity.radius;
      existingBody.money = entity.dimensions.money ?? 0;
      existingBody.selectable = selectable;
      existingBody.collidable = !portalHost;
      existingBody.portalHost = portalHost;
      existingBody.instancedSubworld = instancedSubworld;

      const existingMesh = this.obstacleMeshes.get(entity.id);
      if (existingMesh) {
        existingMesh.position.copy(existingBody.center);
        existingMesh.scale.setScalar(existingBody.radius);
        existingMesh.userData.selectable = existingBody.selectable;
        existingMesh.userData.portalHost = existingBody.portalHost;
        existingMesh.userData.instancedSubworld = existingBody.instancedSubworld;
        this.setObstacleMeshColorChannels(existingMesh, colorChannels);
      }
    }

    for (const id of [...this.obstacleBodiesById.keys()]) {
      if (nextIds.has(id)) {
        continue;
      }
      this.removeObstacleById(id);
    }

    this.obstacles = [...this.obstacleBodiesById.values()];
    this.recolorObstacles();
  }

  private connectMultiplayer(worldId: string): void {
    this.localPlayerId = null;
    this.multiplayerError = null;
    this.nextInputSequence = 0;
    this.lastAckedInputSequence = 0;
    this.lastSnapshotServerTick = 0;
    this.lastReconciliationError = 0;
    this.pendingPredictedInputs.clear();
    this.clearRemotePlayers();

    this.multiplayerClient.connect({
      userId: this.userId,
      worldId,
      avatarId: this.selectedAvatarId,
      callbacks: {
        onStatus: (status) => {
          this.multiplayerStatus = status;
          if (status === "disconnected") {
            this.localPlayerId = null;
            this.clearRemotePlayers();
          }
        },
        onWelcome: (playerId) => {
          this.localPlayerId = playerId;
          this.multiplayerError = null;
          this.sendLocalPlayerUpdate({ recordPrediction: false });
        },
        onSnapshot: (snapshot) => {
          this.applyMultiplayerSnapshot(snapshot);
        },
        onWorldCommit: (commit) => {
          this.applyMultiplayerWorldCommit(commit);
        },
        onError: (message) => {
          this.multiplayerError = message;
        },
      },
    });
  }

  private applyMultiplayerSnapshot(snapshot: MultiplayerSnapshot): void {
    if (snapshot.world_id !== this.currentWorldId) {
      return;
    }

    this.applyLocalPredictionAck(snapshot);

    const nextIds = new Set<string>();
    for (const remotePlayer of snapshot.players) {
      if (remotePlayer.player_id === this.localPlayerId) {
        continue;
      }

      const playerId = remotePlayer.player_id;
      nextIds.add(playerId);
      const renderState = this.upsertRemotePlayerRenderState(
        remotePlayer,
        snapshot.server_tick,
      );
      this.upsertRemotePlayerMesh(playerId, renderState);
    }

    for (const existingId of [...this.remotePlayerRenderStates.keys()]) {
      if (nextIds.has(existingId)) {
        continue;
      }
      this.remotePlayerRenderStates.delete(existingId);
      this.removeRemotePlayerMesh(existingId);
    }
  }

  private applyMultiplayerWorldCommit(commit: MultiplayerWorldCommit): void {
    if (commit.world_id !== this.currentWorldId) {
      return;
    }

    if (commit.saved_to === "user" && commit.user_id !== this.userId) {
      return;
    }

    try {
      const loaded = parseLoadedWorldSnapshot(commit.world);
      this.worldStore.apply({
        type: "hydrateWorld",
        world: loaded.world,
      });
      this.backendWorldTick = loaded.tick;
      this.worldSourceState = commit.saved_to === "master" ? "backend" : "backend-user";
      this.multiplayerError = null;

      if (!this.saveInFlight) {
        this.saveMessage = `synced ${commit.commit_id} via multiplayer`;
      }
    } catch (error) {
      this.multiplayerError =
        error instanceof Error
          ? `world sync failed: ${error.message}`
          : "world sync failed: unknown error";
    }
  }

  private applyLocalPredictionAck(snapshot: MultiplayerSnapshot): void {
    if (!this.localPlayerId) {
      return;
    }

    this.lastSnapshotServerTick = snapshot.server_tick;
    const localPlayer = snapshot.players.find(
      (player) => player.player_id === this.localPlayerId,
    );
    if (!localPlayer) {
      return;
    }

    const rawAck = localPlayer.last_processed_input_tick;
    if (!Number.isFinite(rawAck) || rawAck < 0) {
      return;
    }

    const ackSequence = Math.max(
      this.lastAckedInputSequence,
      Math.trunc(rawAck),
    );

    this.reconcileLocalPrediction(ackSequence, localPlayer);
    this.lastAckedInputSequence = ackSequence;
    this.prunePredictedInputBuffer();
  }

  private reconcileLocalPrediction(
    ackSequence: number,
    localPlayerSnapshot: RemotePlayerState,
  ): void {
    const authoritativePosition = localPlayerSnapshot.position_3d;
    const acknowledgedPrediction = this.pendingPredictedInputs.get(ackSequence);

    if (!acknowledgedPrediction) {
      if (this.pendingPredictedInputs.size === 0) {
        const deltaX = authoritativePosition[0] - this.player.position.x;
        const deltaY = authoritativePosition[1] - this.player.position.y;
        const deltaZ = authoritativePosition[2] - this.player.position.z;
        const error = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
        this.lastReconciliationError = error;

        if (error > RECONCILE_POSITION_EPSILON) {
          this.player.position.set(
            authoritativePosition[0],
            authoritativePosition[1],
            authoritativePosition[2],
          );
        }
      }
      return;
    }

    const deltaX = authoritativePosition[0] - acknowledgedPrediction.position3d[0];
    const deltaY = authoritativePosition[1] - acknowledgedPrediction.position3d[1];
    const deltaZ = authoritativePosition[2] - acknowledgedPrediction.position3d[2];
    const error = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
    this.lastReconciliationError = error;

    if (error <= RECONCILE_POSITION_EPSILON) {
      return;
    }

    this.player.position.set(
      this.player.position.x + deltaX,
      this.player.position.y + deltaY,
      this.player.position.z + deltaZ,
    );

    for (const [sequence, predicted] of this.pendingPredictedInputs) {
      if (sequence <= ackSequence) {
        continue;
      }

      predicted.position3d = [
        predicted.position3d[0] + deltaX,
        predicted.position3d[1] + deltaY,
        predicted.position3d[2] + deltaZ,
      ];
    }
  }

  private prunePredictedInputBuffer(): void {
    for (const sequence of [...this.pendingPredictedInputs.keys()]) {
      if (sequence <= this.lastAckedInputSequence) {
        this.pendingPredictedInputs.delete(sequence);
      }
    }

    while (this.pendingPredictedInputs.size > MAX_PENDING_PREDICTED_INPUTS) {
      const oldest = this.pendingPredictedInputs.keys().next().value;
      if (typeof oldest !== "number") {
        break;
      }
      this.pendingPredictedInputs.delete(oldest);
    }
  }

  private recordPredictedInput(state: PredictedInputState): void {
    this.pendingPredictedInputs.set(state.sequence, state);
    this.prunePredictedInputBuffer();
  }

  private upsertRemotePlayerRenderState(
    remotePlayer: RemotePlayerState,
    serverTick: number,
  ): RemotePlayerRenderState {
    const playerId = remotePlayer.player_id;
    const normalizedServerTick = Number.isFinite(serverTick) ? Math.trunc(serverTick) : 0;
    const existingState = this.remotePlayerRenderStates.get(playerId);
    if (!existingState) {
      const spawnPosition = new THREE.Vector3(
        remotePlayer.position_3d[0],
        remotePlayer.position_3d[1],
        remotePlayer.position_3d[2],
      );
      const normalizedYaw = this.normalizeAngleRadians(remotePlayer.yaw);
      const normalizedPitch = this.normalizeAngleRadians(remotePlayer.pitch);
      const normalizedAvatarId = normalizeAvatarId(remotePlayer.avatar_id);
      const createdState: RemotePlayerRenderState = {
        renderPosition: spawnPosition.clone(),
        targetPosition: spawnPosition,
        renderYaw: normalizedYaw,
        targetYaw: normalizedYaw,
        renderPitch: normalizedPitch,
        targetPitch: normalizedPitch,
        avatarId: normalizedAvatarId,
        lastServerTick: normalizedServerTick,
      };
      this.remotePlayerRenderStates.set(playerId, createdState);
      return createdState;
    }

    if (normalizedServerTick < existingState.lastServerTick) {
      return existingState;
    }

    existingState.targetPosition.set(
      remotePlayer.position_3d[0],
      remotePlayer.position_3d[1],
      remotePlayer.position_3d[2],
    );
    existingState.targetYaw = this.normalizeAngleRadians(remotePlayer.yaw);
    existingState.targetPitch = this.normalizeAngleRadians(remotePlayer.pitch);
    existingState.avatarId = normalizeAvatarId(remotePlayer.avatar_id);
    existingState.lastServerTick = normalizedServerTick;
    return existingState;
  }

  private updateRemotePlayerInterpolation(frameSeconds: number): void {
    if (this.remotePlayerRenderStates.size === 0) {
      return;
    }

    const interpolationAlpha = this.remoteInterpolationAlpha(frameSeconds);
    if (interpolationAlpha <= 0) {
      return;
    }

    for (const [playerId, renderState] of this.remotePlayerRenderStates) {
      const avatarInstance = this.remotePlayerAvatars.get(playerId);
      if (!avatarInstance) {
        continue;
      }

      if (
        renderState.renderPosition.distanceTo(renderState.targetPosition) >
        REMOTE_INTERPOLATION_SNAP_DISTANCE
      ) {
        renderState.renderPosition.copy(renderState.targetPosition);
      } else {
        renderState.renderPosition.lerp(
          renderState.targetPosition,
          interpolationAlpha,
        );
      }

      renderState.renderYaw = this.interpolateAngleRadians(
        renderState.renderYaw,
        renderState.targetYaw,
        interpolationAlpha,
      );
      renderState.renderPitch = this.interpolateAngleRadians(
        renderState.renderPitch,
        renderState.targetPitch,
        interpolationAlpha,
      );

      this.applyRemotePlayerRenderPose(
        avatarInstance.handle,
        renderState.renderPosition,
        renderState.renderYaw,
        renderState.renderPitch,
      );
    }
  }

  private remoteInterpolationAlpha(frameSeconds: number): number {
    const boundedFrameSeconds = Math.max(
      0,
      Math.min(frameSeconds, REMOTE_INTERPOLATION_MAX_FRAME_SECONDS),
    );
    if (boundedFrameSeconds <= 0) {
      return 0;
    }

    return (
      1 -
      Math.exp(
        -boundedFrameSeconds / REMOTE_INTERPOLATION_SMOOTH_TIME_SECONDS,
      )
    );
  }

  private normalizeAngleRadians(angle: number): number {
    if (!Number.isFinite(angle)) {
      return 0;
    }

    let normalized = (angle + Math.PI) % TWO_PI;
    if (normalized < 0) {
      normalized += TWO_PI;
    }
    return normalized - Math.PI;
  }

  private interpolateAngleRadians(
    current: number,
    target: number,
    alpha: number,
  ): number {
    const normalizedCurrent = this.normalizeAngleRadians(current);
    const normalizedTarget = this.normalizeAngleRadians(target);
    const delta = this.normalizeAngleRadians(normalizedTarget - normalizedCurrent);
    if (Math.abs(delta) > REMOTE_INTERPOLATION_SNAP_ANGLE_RADIANS) {
      return normalizedTarget;
    }
    return this.normalizeAngleRadians(normalizedCurrent + delta * alpha);
  }

  private applyRemotePlayerRenderPose(
    avatar: AvatarRenderHandle,
    position: THREE.Vector3,
    yaw: number,
    pitch: number,
  ): void {
    avatar.applyPose(position.x, position.y, position.z, yaw, pitch);
  }

  private upsertRemotePlayerMesh(
    playerId: string,
    renderState: RemotePlayerRenderState,
  ): void {
    const existingAvatar = this.remotePlayerAvatars.get(playerId);
    if (existingAvatar && existingAvatar.avatarId === renderState.avatarId) {
      this.applyRemotePlayerRenderPose(
        existingAvatar.handle,
        renderState.renderPosition,
        renderState.renderYaw,
        renderState.renderPitch,
      );
      return;
    }

    if (existingAvatar) {
      this.scene.remove(existingAvatar.handle.object3d);
      existingAvatar.handle.dispose();
      this.remotePlayerAvatars.delete(playerId);
    }

    const avatar = createRemoteAvatarHandle({
      avatarId: renderState.avatarId,
      playerId,
    });
    this.applyRemotePlayerRenderPose(
      avatar,
      renderState.renderPosition,
      renderState.renderYaw,
      renderState.renderPitch,
    );
    this.scene.add(avatar.object3d);
    this.remotePlayerAvatars.set(playerId, {
      avatarId: renderState.avatarId,
      handle: avatar,
    });
  }

  private removeRemotePlayerMesh(playerId: string): void {
    const avatarInstance = this.remotePlayerAvatars.get(playerId);
    if (!avatarInstance) {
      return;
    }

    this.scene.remove(avatarInstance.handle.object3d);
    avatarInstance.handle.dispose();
    this.remotePlayerAvatars.delete(playerId);
  }

  private clearRemotePlayers(): void {
    for (const playerId of [...this.remotePlayerAvatars.keys()]) {
      this.removeRemotePlayerMesh(playerId);
    }
    this.remotePlayerRenderStates.clear();
  }

  private addObstacleMesh(
    obstacle: ObstacleBody,
    colorChannels: SphereColorChannels,
  ): void {
    const sphereGeometry = new THREE.SphereGeometry(1, 24, 18);
    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: DEFAULT_SPHERE_COLOR_HEX,
      roughness: 0.75,
      metalness: 0.08,
    });
    const obstacleMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
    obstacleMesh.position.copy(obstacle.center);
    obstacleMesh.scale.setScalar(obstacle.radius);
    obstacleMesh.userData.sphereId = obstacle.id;
    obstacleMesh.userData.selectable = obstacle.selectable;
    obstacleMesh.userData.portalHost = obstacle.portalHost;
    obstacleMesh.userData.instancedSubworld = obstacle.instancedSubworld;
    this.setObstacleMeshColorChannels(obstacleMesh, colorChannels);
    this.scene.add(obstacleMesh);
    this.worldMeshes.set(obstacle.id, obstacleMesh);
    this.obstacleMeshes.set(obstacle.id, obstacleMesh);
  }

  private removeObstacleById(obstacleId: string): void {
    this.obstacleBodiesById.delete(obstacleId);

    const mesh = this.obstacleMeshes.get(obstacleId);
    if (mesh) {
      this.scene.remove(mesh);

      mesh.geometry.dispose();
      if (Array.isArray(mesh.material)) {
        for (const material of mesh.material) {
          material.dispose();
        }
      } else {
        mesh.material.dispose();
      }
    }

    this.obstacleMeshes.delete(obstacleId);
    this.worldMeshes.delete(obstacleId);
  }

  private readonly onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private readonly onPointerLockChange = (): void => {
    if (this.controller.isPointerLocked()) {
      this.hintNode.style.opacity = "0";
      return;
    }
    this.hintNode.style.opacity = "1";
  };

  private isEditorHudTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Node &&
      (this.templateHudNode.contains(target) || this.levelSelectNode.contains(target))
    );
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

  private readonly onSelectedColorInput = (): void => {
    if (!this.editorMode) {
      return;
    }

    const selectedSphere = this.getSelectedEditableSphere();
    if (!selectedSphere) {
      return;
    }

    const parsedColor = this.parseColorInputValue(this.selectedColorInputNode.value);
    if (!parsedColor) {
      return;
    }

    const dimensions = this.toColorDimensions(parsedColor);
    const changed = this.worldStore.apply({
      type: "updateSphereDimensions",
      sphereId: selectedSphere.id,
      dimensions,
    });
    if (!changed) {
      return;
    }

    this.queueUpdateDimensionsOperation(selectedSphere.id, dimensions);
    this.refreshPendingSaveMessage();
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.editorMode) {
      return;
    }

    if (this.isEditorHudTarget(event.target)) {
      return;
    }

    const selectedSphere = this.getSelectedEditableSphere();
    if (!selectedSphere) {
      return;
    }

    const direction = event.deltaY < 0 ? 1 : -1;

    event.preventDefault();
    const maxRadius = Math.max(
      MIN_EDIT_RADIUS,
      this.parentSphere.radius - CREATE_BOUNDARY_MARGIN - PLAYER_RADIUS,
    );
    const nextRadius = Math.max(
      MIN_EDIT_RADIUS,
      Math.min(maxRadius, selectedSphere.radius + direction * MOUSE_WHEEL_RADIUS_STEP),
    );
    const roundedRadius = Number(nextRadius.toFixed(3));
    if (roundedRadius === selectedSphere.radius) {
      return;
    }

    const changed = this.worldStore.apply({
      type: "updateSphereRadius",
      sphereId: selectedSphere.id,
      radius: roundedRadius,
    });
    if (!changed) {
      return;
    }

    this.queueUpdateRadiusOperation(selectedSphere.id, roundedRadius);
    this.refreshPendingSaveMessage();
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (!this.editorMode || event.button !== 2) {
      return;
    }

    if (!this.controller.isPointerLocked()) {
      return;
    }

    if (this.isEditorHudTarget(event.target)) {
      return;
    }

    if (!this.worldStore.getSelectedSphereId()) {
      this.selectSphereAtReticle();
    }

    const selectedSphere = this.getSelectedEditableSphere();
    if (!selectedSphere) {
      this.stopDraggingSphere();
      return;
    }

    event.preventDefault();
    this.draggingSphereId = selectedSphere.id;
    tempOffset
      .set(selectedSphere.position3d[0], selectedSphere.position3d[1], selectedSphere.position3d[2])
      .sub(this.player.position);
    const maxDistance = Math.max(
      DRAG_MIN_DISTANCE,
      this.parentSphere.radius - selectedSphere.radius - CREATE_BOUNDARY_MARGIN,
    );
    this.dragDistance = Math.max(
      DRAG_MIN_DISTANCE,
      Math.min(maxDistance, tempOffset.length()),
    );
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button !== 2) {
      return;
    }

    this.stopDraggingSphere();
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (this.editorMode && this.controller.isPointerLocked()) {
      event.preventDefault();
    }
  };

  private readonly onWindowBlur = (): void => {
    this.stopDraggingSphere();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.saveWorldCommit();
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
      this.overlayEnabled = !this.overlayEnabled;
      this.recolorObstacles();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.toggleEditorMode)) {
      event.preventDefault();
      this.toggleEditorMode();
      return;
    }

    if (!this.editorMode) {
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.createSphere)) {
      event.preventDefault();
      this.createSphereInFrontOfPlayer();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.deselectSphere)) {
      event.preventDefault();
      this.stopDraggingSphere();
      this.worldStore.apply({ type: "deselectSphere" });
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.selectLookedAtSphere)) {
      event.preventDefault();
      this.selectSphereAtReticle();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.enterSelectedSphereWorld)) {
      event.preventDefault();
      this.handleEnterOrExitWorldShortcut();
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.deleteSelectedSphere)) {
      event.preventDefault();
      this.deleteSelectedSphere();
    }
  };

  private readonly animate = (): void => {
    const frameSeconds = Math.min(this.clock.getDelta(), 0.05);
    this.accumulatorSeconds += frameSeconds;

    while (this.accumulatorSeconds >= FIXED_STEP_SECONDS) {
      this.updateFixed(FIXED_STEP_SECONDS);
      this.accumulatorSeconds -= FIXED_STEP_SECONDS;
    }

    this.updateRemotePlayerInterpolation(frameSeconds);
    this.syncCamera();
    this.updateHud();
    this.renderer.render(this.scene, this.camera);
  };

  private sendLocalPlayerUpdate(options: { recordPrediction: boolean } = { recordPrediction: true }): void {
    const orientation = this.controller.getOrientation();
    const inputSequence = this.nextPlayerInputSequence();

    if (options.recordPrediction) {
      this.recordPredictedInput({
        sequence: inputSequence,
        simulationTick: this.tick,
        position3d: [this.player.position.x, this.player.position.y, this.player.position.z],
        yaw: orientation.yaw,
        pitch: orientation.pitch,
      });
    }

    this.multiplayerClient.sendPlayerUpdate(
      [this.player.position.x, this.player.position.y, this.player.position.z],
      orientation.yaw,
      orientation.pitch,
      inputSequence,
      this.selectedAvatarId,
    );
    this.lastNetworkSendTick = this.tick;
  }

  private updateFixed(dt: number): void {
    this.tick += 1;
    const input = this.controller.sampleInput();
    const orientation = this.controller.getOrientation();

    const moveDirection = new THREE.Vector3();
    if (input.forward !== 0 || input.right !== 0) {
      const forward = new THREE.Vector3(Math.sin(orientation.yaw), 0, Math.cos(orientation.yaw));
      const right = new THREE.Vector3(forward.z, 0, -forward.x);
      moveDirection
        .addScaledVector(forward, -input.forward)
        .addScaledVector(right, input.right)
        .normalize();
    }

    if (this.player.grounded) {
      this.player.velocity.x = moveDirection.x * MOVE_SPEED;
      this.player.velocity.z = moveDirection.z * MOVE_SPEED;
      const groundedDragScale = 1 / (1 + DRAG_GROUNDED * dt);
      this.player.velocity.x *= groundedDragScale;
      this.player.velocity.z *= groundedDragScale;
      if (input.jump) {
        this.player.velocity.y = JUMP_SPEED;
        this.player.grounded = false;
      } else {
        this.player.velocity.y = 0;
      }
    } else {
      const targetX = moveDirection.x * MOVE_SPEED;
      const targetZ = moveDirection.z * MOVE_SPEED;
      this.player.velocity.x += (targetX - this.player.velocity.x) * AIR_CONTROL * dt;
      this.player.velocity.z += (targetZ - this.player.velocity.z) * AIR_CONTROL * dt;
      this.player.velocity.multiplyScalar(1 / (1 + DRAG_AIR * dt));
    }

    if (!this.player.grounded) {
      this.player.velocity.y -= GRAVITY * dt;
    }
    this.player.position.addScaledVector(this.player.velocity, dt);

    this.lastCollisionCount = resolveSphereCollisions(this.player, this.obstacles);
    constrainInsideParentSphere(this.player, this.parentCenter, this.parentSphere.radius);
    this.updateDraggedSphere(orientation);

    if (this.tick - this.lastNetworkSendTick >= NETWORK_SEND_INTERVAL_TICKS) {
      this.sendLocalPlayerUpdate({ recordPrediction: true });
    }
  }

  private nextPlayerInputSequence(): number {
    if (this.nextInputSequence >= Number.MAX_SAFE_INTEGER) {
      this.nextInputSequence = 1;
      return this.nextInputSequence;
    }

    this.nextInputSequence += 1;
    return this.nextInputSequence;
  }

  private syncCamera(): void {
    const orientation = this.controller.getOrientation();
    this.camera.rotation.order = "YXZ";
    this.camera.rotation.y = orientation.yaw;
    this.camera.rotation.x = orientation.pitch;
    this.camera.position.copy(this.player.position);
  }

  private recolorObstacles(): void {
    const selectedSphereId = this.worldStore.getSelectedSphereId();

    for (const obstacle of this.obstacles) {
      const obstacleMesh = this.obstacleMeshes.get(obstacle.id);
      if (!obstacleMesh || !(obstacleMesh.material instanceof THREE.MeshStandardMaterial)) {
        continue;
      }

      if (obstacle.portalHost && !this.editorMode) {
        obstacleMesh.visible = false;
        continue;
      }
      obstacleMesh.visible = true;

      const baseColorChannels = this.readObstacleMeshColorChannels(obstacleMesh);
      const baseColor = new THREE.Color(
        baseColorChannels.r,
        baseColorChannels.g,
        baseColorChannels.b,
      );
      const overlayColor = new THREE.Color(0x2f7aff);
      const blend = this.overlayEnabled ? Math.max(0, Math.min(1, obstacle.money)) : 0;
      obstacleMesh.material.color.copy(baseColor).lerp(overlayColor, blend);
      obstacleMesh.material.emissive.setHex(0x000000).lerp(new THREE.Color(0x103a8f), blend * 0.35);

      if (obstacle.portalHost) {
        obstacleMesh.material.transparent = true;
        obstacleMesh.material.opacity = 0.24;
        obstacleMesh.material.depthWrite = false;
        obstacleMesh.material.wireframe = true;
      } else {
        obstacleMesh.material.transparent = false;
        obstacleMesh.material.opacity = 1;
        obstacleMesh.material.depthWrite = true;
        obstacleMesh.material.wireframe = false;
      }

      const selected = obstacle.id === selectedSphereId;
      if (selected) {
        obstacleMesh.material.emissive.lerp(new THREE.Color(0xffae42), 0.75);
        obstacleMesh.material.roughness = 0.45;
        obstacleMesh.material.metalness = 0.24;
      } else {
        obstacleMesh.material.roughness = 0.75;
        obstacleMesh.material.metalness = 0.08;
      }

      obstacleMesh.material.needsUpdate = true;
    }
  }

  private toggleEditorMode(): void {
    this.editorMode = !this.editorMode;
    if (this.parentMesh) {
      this.parentMesh.visible = this.editorMode;
    }
    if (!this.editorMode) {
      this.stopDraggingSphere();
      this.worldStore.apply({ type: "deselectSphere" });
    }
    this.updateHintText();
    this.updateTemplateHud();
    this.updateLevelSelectHud();
    this.recolorObstacles();
  }

  private nextCreatedSphereId(): string {
    const userPrefix = this.userId.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 12) || "local";

    for (let attempt = 0; attempt < 256; attempt += 1) {
      this.createdSphereCount += 1;
      const id = `sphere-user-${userPrefix}-${String(this.createdSphereCount).padStart(4, "0")}`;
      if (!this.worldStore.getSphereById(id)) {
        return id;
      }
    }

    return `sphere-user-${userPrefix}-${Date.now().toString(36)}`;
  }

  private createSphereInFrontOfPlayer(): void {
    const id = this.nextCreatedSphereId();
    this.camera.getWorldDirection(tempForward);

    const createdSphereRadius = Number(
      Math.min(
        CREATED_SPHERE_RADIUS,
        Math.max(MIN_EDIT_RADIUS * 2, this.parentSphere.radius * 0.12),
      ).toFixed(3),
    );
    const minimumCreateDistance = PLAYER_RADIUS + createdSphereRadius + 0.8;
    const createDistance = Math.min(
      CREATE_DISTANCE,
      Math.max(minimumCreateDistance, this.parentSphere.radius * 0.42),
    );

    const center = this.player.position
      .clone()
      .addScaledVector(tempForward.normalize(), createDistance);

    tempOffset.copy(center).sub(this.parentCenter);
    const distanceFromCenter = tempOffset.length();
    const maxDistance = this.parentSphere.radius - createdSphereRadius - CREATE_BOUNDARY_MARGIN;
    if (distanceFromCenter > maxDistance) {
      if (distanceFromCenter > 1e-6) {
        center.copy(this.parentCenter).addScaledVector(tempOffset.normalize(), maxDistance);
      } else {
        center.copy(this.parentCenter).add(new THREE.Vector3(0, 0, maxDistance));
      }
    }

    const dimensions: Record<string, number> = {
      money: Math.random(),
      [SUBWORLD_TEMPLATE_DIMENSION]: this.createTemplateId,
      ...this.getDefaultColorDimensions(),
    };
    if (this.createTemplateId > TEMPLATE_NONE_ID) {
      dimensions[SUBWORLD_SCALE_DIMENSION] = 1;
    }

    const tags = ["user-created"];
    if (this.createTemplateId > TEMPLATE_NONE_ID) {
      tags.push("world-instance");
    }

    const sphere: SphereEntity = {
      id,
      parentId: this.parentSphere.id,
      radius: createdSphereRadius,
      position3d: [center.x, center.y, center.z],
      dimensions,
      timeWindow: {
        start: this.tick,
        end: null,
      },
      tags,
    };

    const changed = this.worldStore.apply({
      type: "createSphere",
      selectCreated: true,
      sphere,
    });

    if (changed) {
      this.queueCreateSphereOperation(sphere);
      this.refreshPendingSaveMessage();
    }
  }

  private selectSphereAtReticle(): void {
    const meshes = [...this.obstacleMeshes.values()];
    if (meshes.length === 0) {
      this.worldStore.apply({ type: "deselectSphere" });
      return;
    }

    this.raycaster.setFromCamera(tempRaycastPoint, this.camera);
    const intersections = this.raycaster.intersectObjects(meshes, false);
    if (intersections.length === 0) {
      return;
    }

    const selectedIntersection = intersections.find((intersection) => {
      const mesh = intersection.object as THREE.Mesh;
      return mesh.userData.selectable !== false && typeof mesh.userData.sphereId === "string";
    });
    if (!selectedIntersection) {
      return;
    }

    const selectedObject = selectedIntersection.object as THREE.Mesh;
    const selectedId = selectedObject.userData.sphereId;
    if (typeof selectedId === "string") {
      this.worldStore.apply({
        type: "selectSphere",
        sphereId: selectedId,
      });
    }
  }

  private deleteSelectedSphere(): void {
    const selectedId = this.worldStore.getSelectedSphereId();
    if (!selectedId) {
      return;
    }

    if (this.draggingSphereId === selectedId) {
      this.stopDraggingSphere();
    }

    const changed = this.worldStore.apply({
      type: "deleteSphere",
      sphereId: selectedId,
    });

    if (changed) {
      this.pendingCommitOperations.push({
        type: "delete",
        sphereId: selectedId,
      });
      this.refreshPendingSaveMessage();
    }
  }

  private updateHintText(): void {
    if (this.editorMode) {
      this.hintNode.textContent =
        "EDIT MODE | ~ exit editor | C create | E select | F enter selected template / exit | Q deselect | Z delete | wheel resize | hold RMB drag | use Level Select panel";
      return;
    }

    this.hintNode.textContent =
      "Click to lock pointer | WASD + Space | O overlay | ~ editor mode | Cmd/Ctrl+S save";
  }

  private updateHud(): void {
    this.hudNode.hidden = !this.editorMode;
    if (!this.editorMode) {
      return;
    }

    const selectedSphereId = this.worldStore.getSelectedSphereId();

    this.hudNode.textContent =
      `tick: ${this.tick}\n` +
      `position: ${this.player.position.x.toFixed(2)}, ${this.player.position.y.toFixed(2)}, ${this.player.position.z.toFixed(2)}\n` +
      `velocity: ${this.player.velocity.x.toFixed(2)}, ${this.player.velocity.y.toFixed(2)}, ${this.player.velocity.z.toFixed(2)}\n` +
      `grounded: ${this.player.grounded ? "yes" : "no"}\n` +
      `collisions: ${this.lastCollisionCount}\n` +
      `overlay: ${this.overlayEnabled ? "money (blue)" : "off"}\n` +
      `editor: ${this.editorMode ? "on" : "off"}\n` +
      `dragging: ${this.draggingSphereId ?? "none"}\n` +
      `create template: ${this.createTemplateId}\n` +
      `avatar: ${this.selectedAvatarId}\n` +
      `selected: ${selectedSphereId ?? "none"}\n` +
      `world id: ${this.currentWorldId}\n` +
      `levels: ${this.availableWorldIds.length}\n` +
      `world parent: ${this.parentSphere.id}\n` +
      `spheres: ${this.obstacles.length}\n` +
      `world source: ${this.worldSourceState}\n` +
      `world tick: ${this.backendWorldTick}\n` +
      `pending edits: ${this.pendingCommitOperations.length}\n` +
      `save: ${this.saveMessage}\n` +
      `user: ${this.userId}\n` +
      `multiplayer: ${this.multiplayerStatus}\n` +
      `player id: ${this.localPlayerId ?? "pending"}\n` +
      `remote players: ${this.remotePlayerRenderStates.size}\n` +
      `input seq ack: ${this.lastAckedInputSequence}\n` +
      `pending predicted inputs: ${this.pendingPredictedInputs.size}\n` +
      `last snapshot tick: ${this.lastSnapshotServerTick}\n` +
      `reconcile error: ${this.lastReconciliationError.toFixed(4)}\n` +
      `mp error: ${this.multiplayerError ?? "none"}`;
  }
}
