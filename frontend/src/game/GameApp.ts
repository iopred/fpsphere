import * as THREE from "three";
import type { SphereEntity } from "@fpsphere/shared-types";
import { FpsController } from "./FpsController";
import {
  constrainInsideParentSphere,
  resolveSphereCollisions,
  type ObstacleBody,
  type PlayerBody,
} from "./physics";
import {
  getTemplateRootRadius,
  getTemplateRootSphereId,
  instantiateSubworldChildren,
  resolveTemplateSeedId,
  TEMPLATE_DEFINITION_TAG,
  TEMPLATE_ROOT_TAG,
  SUBWORLD_SCALE_DIMENSION,
  SUBWORLD_TEMPLATE_DIMENSION,
  SUBWORLD_YAW_DIMENSION,
  SUBWORLD_PITCH_DIMENSION,
} from "./subworldTemplates";
import { buildSeedWorld, type SeedWorld } from "./worldSeed";
import {
  fetchWorldSeed,
  parseLoadedWorldSnapshot,
  type WorldCommitOperation,
} from "./worldApi";
import {
  MultiplayerClient,
  type MultiplayerSnapshot,
  type MultiplayerServerResetNotice,
  type MultiplayerWorldContext,
  type MultiplayerWorldCommit,
} from "./multiplayerClient";
import { LocalWorldStore, type WorldStoreSnapshot } from "./worldStore";
import {
  availableAvatarIds,
  avatarLabel,
  DEFAULT_AVATAR_ID,
  type AvatarId,
} from "./avatarRenderAdapter";
import {
  templatePlacementPlaybackProgress,
  templatePlacementPlaybackScale,
} from "./templatePlacementPlayback";
import { RemoteAvatarRenderSystem } from "./remoteAvatarRenderSystem";
import { LocalPredictionReconciler } from "./localPredictionReconciler";
import {
  LevelLifecycleController,
  type WorldSourceState,
} from "./levelLifecycleController";
import { LevelSelectPanel } from "./levelSelectPanel";
import { TemplateHudPanel } from "./templateHudPanel";
import { GameplayHudPanel } from "./gameplayHudPanel";
import { EditorInteractionController } from "./editorInteractionController";
import { EditorKeyboardController } from "./editorKeyboardController";
import { EditorActionsController } from "./editorActionsController";
import {
  decodeTemplateIdFromInstanceWorldId,
  resolveTemplateIdFromEntity,
} from "./worldInstanceRefs";

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
const MOUSE_WHEEL_RADIUS_PER_PIXEL = 0.0022;
const DRAG_MIN_DISTANCE = 1.5;
const TEMPLATE_ROTATE_RADIANS_PER_PIXEL = 0.0055;
const TEMPLATE_PITCH_LIMIT_RADIANS = Math.PI * 0.495;
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

interface TemplatePlacementPlaybackState {
  startTick: number;
}

function cloneSphereEntity(entity: SphereEntity): SphereEntity {
  return {
    id: entity.id,
    parentId: entity.parentId,
    radius: entity.radius,
    position3d: [...entity.position3d],
    dimensions: { ...entity.dimensions },
    instanceWorldId: entity.instanceWorldId ?? null,
    timeWindow: { ...entity.timeWindow },
    tags: [...entity.tags],
  };
}

const TEMPLATE_PLACEMENT_PLAYBACK_DURATION_TICKS = 42;
const TEMPLATE_PLACEMENT_PLAYBACK_MAX_AGE_TICKS = 180;

export class GameApp {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly clock = new THREE.Clock();
  private readonly gameplayHudPanel: GameplayHudPanel;
  private readonly editorPanelsNode: HTMLDivElement;
  private readonly templateHudPanel: TemplateHudPanel;
  private readonly levelSelectPanel: LevelSelectPanel;
  private readonly editorActionsController: EditorActionsController;
  private readonly editorKeyboardController: EditorKeyboardController;

  private readonly controller: FpsController;
  private readonly worldStore = new LocalWorldStore(buildSeedWorld());
  private parentSphere = this.worldStore.getParentSphere();
  private parentMesh: THREE.Mesh | null = null;

  private readonly parentCenter = new THREE.Vector3(
    this.parentSphere.position3d[0],
    this.parentSphere.position3d[1],
    this.parentSphere.position3d[2],
  );
  private readonly templateRotationOffset = new THREE.Vector3();
  private readonly templateRotationEuler = new THREE.Euler(0, 0, 0, "YXZ");

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
  private readonly remoteAvatarRenderSystem = new RemoteAvatarRenderSystem(this.scene);
  private readonly avatarIdChoices = availableAvatarIds();
  private readonly worldNavigationStack: string[] = [];
  private readonly instancedWorldById = new Map<string, SeedWorld>();
  private readonly instancedWorldLoadInFlight = new Set<string>();
  private obstacles: ObstacleBody[] = [];
  private unsubscribeWorldStore: (() => void) | null = null;
  private accumulatorSeconds = 0;
  private tick = 0;
  private lastCollisionCount = 0;
  private overlayEnabled = false;
  private editorMode = false;
  private createInstanceWorldId: string | null = null;
  private createTemplateId = TEMPLATE_NONE_ID;
  private readonly editorInteractionController: EditorInteractionController;
  private pendingCommitOperations: WorldCommitOperation[] = [];
  private readonly userId = this.getOrCreateUserId();
  private readonly levelLifecycleController: LevelLifecycleController;
  private localPlayerId: string | null = null;
  private multiplayerStatus = "disconnected";
  private multiplayerError: string | null = null;
  private serverResetReloadInFlight = false;
  private selectedAvatarId: AvatarId = DEFAULT_AVATAR_ID;
  private lastNetworkSendTick = 0;
  private nextInputSequence = 0;
  private readonly localPredictionReconciler = new LocalPredictionReconciler(this.player);
  private readonly templatePlacementPlaybackById = new Map<
    string,
    TemplatePlacementPlaybackState
  >();
  private disposed = false;

  private get currentWorldId(): string {
    return this.levelLifecycleController.worldId;
  }

  private get availableWorldIds(): string[] {
    return this.levelLifecycleController.worldIds;
  }

  private get saveInFlight(): boolean {
    return this.levelLifecycleController.isSaveInFlight;
  }

  private get saveMessage(): string {
    return this.levelLifecycleController.currentSaveMessage;
  }

  private get backendWorldTick(): number {
    return this.levelLifecycleController.currentBackendWorldTick;
  }

  private get worldSourceState(): WorldSourceState {
    return this.levelLifecycleController.currentWorldSourceState;
  }

  constructor(private readonly mountNode: HTMLDivElement) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.mountNode.appendChild(this.renderer.domElement);

    this.gameplayHudPanel = new GameplayHudPanel(this.mountNode);

    this.editorPanelsNode = document.createElement("div");
    this.editorPanelsNode.className = "editor-panels";
    this.mountNode.appendChild(this.editorPanelsNode);

    this.templateHudPanel = new TemplateHudPanel(
      this.encodeColorInputValue({
        r: DEFAULT_SPHERE_COLOR_RED,
        g: DEFAULT_SPHERE_COLOR_GREEN,
        b: DEFAULT_SPHERE_COLOR_BLUE,
      }),
      {
        onSelectCreateWorld: (instanceWorldId) =>
          this.setCreateInstanceWorldId(instanceWorldId),
        onSelectSelectedWorld: (instanceWorldId) =>
          this.setSelectedSphereInstanceWorldId(instanceWorldId),
        onAdjustAvatar: (delta) => this.adjustSelectedAvatarId(delta),
        onColorInput: (value) => this.onSelectedColorInput(value),
      },
    );
    this.editorPanelsNode.appendChild(this.templateHudPanel.rootNode);

    this.levelSelectPanel = new LevelSelectPanel({
      onSelectWorld: (worldId) => {
        void this.selectWorldLevel(worldId);
      },
      onRemoveSelectedWorld: (worldId) => {
        void this.deleteWorldLevelById(worldId);
      },
      onCreateFromInput: () => {
        void this.createLevelFromInput();
      },
      onRefresh: () => {
        void this.refreshAvailableWorldIds({ preserveCurrentWorldId: true });
      },
    });
    this.editorPanelsNode.appendChild(this.levelSelectPanel.rootNode);

    const queryWorldId = new URLSearchParams(window.location.search).get("world");
    const initialWorldId =
      queryWorldId && queryWorldId.trim().length > 0 ? queryWorldId.trim() : undefined;

    this.levelLifecycleController = new LevelLifecycleController({
      defaultWorldId: DEFAULT_WORLD_ID,
      initialWorldId,
      ui: this.levelSelectPanel.refs,
      callbacks: {
        userId: this.userId,
        isDisposed: () => this.disposed,
        isEditorMode: () => this.editorMode,
        getPendingCommitOperations: () => this.pendingCommitOperations,
        replacePendingCommitOperations: (operations) => {
          this.pendingCommitOperations = operations;
        },
        stopDraggingSphere: () => this.stopDraggingSphere(),
        deselectSphere: () => {
          this.worldStore.apply({ type: "deselectSphere" });
        },
        updateWorldQueryParam: (worldId) => this.updateWorldQueryParam(worldId),
        connectMultiplayer: (worldId) => this.connectMultiplayer(worldId),
        movePlayerToCurrentWorld: () => this.movePlayerToCurrentWorld(),
        hydrateWorld: (world) =>
          this.worldStore.apply({
            type: "hydrateWorld",
            world,
          }),
        getWorldContext: () => this.getMultiplayerWorldContext(),
      },
    });

    this.controller = new FpsController(this.renderer.domElement);
    this.editorActionsController = new EditorActionsController(
      {
        createdSphereRadius: CREATED_SPHERE_RADIUS,
        minEditRadius: MIN_EDIT_RADIUS,
        playerRadius: PLAYER_RADIUS,
        createDistance: CREATE_DISTANCE,
        createBoundaryMargin: CREATE_BOUNDARY_MARGIN,
        templateNoneId: TEMPLATE_NONE_ID,
        subworldTemplateDimension: SUBWORLD_TEMPLATE_DIMENSION,
        subworldScaleDimension: SUBWORLD_SCALE_DIMENSION,
      },
      {
        getUserId: () => this.userId,
        getExistingSphereById: (sphereId) => this.worldStore.getSphereById(sphereId),
        getParentSphere: () => this.parentSphere,
        getParentCenter: () => this.parentCenter,
        getPlayerPosition: () => this.player.position,
        getCamera: () => this.camera,
        getCreateTemplateId: () => this.createTemplateId,
        getCreateInstanceWorldId: () => this.createInstanceWorldId,
        getTick: () => this.tick,
        getDefaultColorDimensions: () => this.getDefaultColorDimensions(),
        randomMoney: () => Math.random(),
        createSphere: (sphere, selectCreated) =>
          this.worldStore.apply({
            type: "createSphere",
            selectCreated,
            sphere,
          }),
        onSphereCreated: (sphere) => {
          this.queueCreateSphereOperation(sphere);
          this.refreshPendingSaveMessage();
        },
        listObstacleMeshes: () => [...this.obstacleMeshes.values()],
        deselectSphere: () => {
          this.worldStore.apply({ type: "deselectSphere" });
        },
        selectSphere: (sphereId) => {
          this.worldStore.apply({
            type: "selectSphere",
            sphereId,
          });
        },
        getSelectedSphereId: () => this.worldStore.getSelectedSphereId(),
        getDraggingSphereId: () => this.editorInteractionController.currentDraggingSphereId,
        stopDraggingSphere: () => this.stopDraggingSphere(),
        deleteSphere: (sphereId) =>
          this.worldStore.apply({
            type: "deleteSphere",
            sphereId,
          }),
        onSphereDeleted: (sphereId) => {
          this.pendingCommitOperations.push({
            type: "delete",
            sphereId,
          });
          this.refreshPendingSaveMessage();
        },
      },
    );
    this.editorInteractionController = new EditorInteractionController({
      config: {
        minEditRadius: MIN_EDIT_RADIUS,
        mouseWheelRadiusPerPixel: MOUSE_WHEEL_RADIUS_PER_PIXEL,
        dragMinDistance: DRAG_MIN_DISTANCE,
        createBoundaryMargin: CREATE_BOUNDARY_MARGIN,
        playerRadius: PLAYER_RADIUS,
        createDistance: CREATE_DISTANCE,
        templateNoneId: TEMPLATE_NONE_ID,
        templateDimension: SUBWORLD_TEMPLATE_DIMENSION,
        templateYawDimension: SUBWORLD_YAW_DIMENSION,
        templatePitchDimension: SUBWORLD_PITCH_DIMENSION,
        templatePitchLimit: TEMPLATE_PITCH_LIMIT_RADIANS,
        templateRotateRadiansPerPixel: TEMPLATE_ROTATE_RADIANS_PER_PIXEL,
      },
      callbacks: {
        isEditorMode: () => this.editorMode,
        isPointerLocked: () => this.controller.isPointerLocked(),
        isEditorHudTarget: (target) => this.isEditorHudTarget(target),
        getSelectedSphereId: () => this.worldStore.getSelectedSphereId(),
        getSelectedEditableSphere: () => this.getSelectedEditableSphere(),
        selectSphereAtReticle: () => this.editorActionsController.selectSphereAtReticle(),
        getPlayerPosition: () => this.player.position,
        getParentCenter: () => this.parentCenter,
        getParentRadius: () => this.parentSphere.radius,
        updateSphereRadius: (sphereId, radius) =>
          this.worldStore.apply({
            type: "updateSphereRadius",
            sphereId,
            radius,
          }),
        onSphereRadiusChanged: (sphereId, radius) => {
          this.queueUpdateRadiusOperation(sphereId, radius);
          this.refreshPendingSaveMessage();
        },
        updateSpherePosition: (sphereId, position3d) =>
          this.worldStore.apply({
            type: "updateSpherePosition",
            sphereId,
            position3d,
          }),
        onSpherePositionChanged: (sphereId, position3d) => {
          this.queueMoveOperation(sphereId, position3d);
          this.refreshPendingSaveMessage();
        },
        updateSphereDimensions: (sphereId, dimensions) =>
          this.worldStore.apply({
            type: "updateSphereDimensions",
            sphereId,
            dimensions,
          }),
        onSphereDimensionsChanged: (sphereId, dimensions) => {
          this.queueUpdateDimensionsOperation(sphereId, dimensions);
          this.refreshPendingSaveMessage();
        },
      },
    });
    this.editorKeyboardController = new EditorKeyboardController({
      requestSave: () => {
        void this.saveWorldCommit();
      },
      isEditorMode: () => this.editorMode,
      toggleOverlay: () => {
        this.overlayEnabled = !this.overlayEnabled;
        this.recolorObstacles();
      },
      toggleEditorMode: () => this.toggleEditorMode(),
      createSphere: () => this.editorActionsController.createSphereInFrontOfPlayer(),
      deselectSphere: () => {
        this.stopDraggingSphere();
        this.worldStore.apply({ type: "deselectSphere" });
      },
      selectSphereAtReticle: () => this.editorActionsController.selectSphereAtReticle(),
      enterSelectedSphereWorld: () => {
        void this.handleEnterOrExitWorldShortcut();
      },
      deleteSelectedSphere: () => this.editorActionsController.deleteSelectedSphere(),
    });

    this.setupScene();
    this.unsubscribeWorldStore = this.worldStore.subscribe(this.onWorldStoreChanged);
    this.gameplayHudPanel.renderHint(this.editorMode);
    this.updateTemplateHud();
    this.updateLevelSelectHud();
    this.recolorObstacles();
    void this.initializeLevelSelection();

    window.addEventListener("resize", this.onResize);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("keydown", this.onKeyDown);
    document.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("mousemove", this.onMouseMove);
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
    this.remoteAvatarRenderSystem.reset();
    window.removeEventListener("resize", this.onResize);
    document.removeEventListener("pointerlockchange", this.onPointerLockChange);
    document.removeEventListener("keydown", this.onKeyDown);
    document.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("mousemove", this.onMouseMove);
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
    this.cacheCurrentWorldDefinition();
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
    const draggingSphereId = this.editorInteractionController.currentDraggingSphereId;
    if (
      draggingSphereId !== null &&
      !snapshot.children.some((child) => child.id === draggingSphereId)
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
    this.cacheCurrentWorldDefinition();
    this.updateTemplateHud();
  };

  private cacheCurrentWorldDefinition(): void {
    const root = this.worldStore.getRootSphere();
    const descendants = this.worldStore
      .listDescendantsOf(root.id)
      .map((entity) => cloneSphereEntity(entity));
    this.instancedWorldById.set(this.currentWorldId, {
      parent: cloneSphereEntity(root),
      children: descendants,
    });
  }

  private async initializeLevelSelection(): Promise<void> {
    await this.levelLifecycleController.initializeLevelSelection();
  }

  private async refreshAvailableWorldIds(options: {
    preserveCurrentWorldId: boolean;
  }): Promise<void> {
    await this.levelLifecycleController.refreshAvailableWorldIds(options);
  }

  private async createLevelFromInput(): Promise<void> {
    await this.levelLifecycleController.createLevelFromInput();
  }

  private async deleteWorldLevelById(worldId: string): Promise<void> {
    await this.levelLifecycleController.deleteWorldLevelById(worldId);
  }

  private updateWorldQueryParam(worldId: string): void {
    const url = new URL(window.location.href);
    url.searchParams.set("world", worldId);
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  private async selectWorldLevel(worldIdInput: string, force: boolean = false): Promise<void> {
    if (!force) {
      this.worldNavigationStack.length = 0;
    }
    await this.levelLifecycleController.selectWorldLevel(worldIdInput, force);
  }

  private updateLevelSelectHud(): void {
    this.levelLifecycleController.renderLevelSelectHud();
  }

  private refreshPendingSaveMessage(): void {
    this.levelLifecycleController.refreshPendingSaveMessage();
  }

  private async saveWorldCommit(): Promise<void> {
    await this.levelLifecycleController.saveWorldCommit();
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
        instanceWorldId: sphere.instanceWorldId ?? null,
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

  private queueUpdateInstanceWorldOperation(
    sphereId: string,
    instanceWorldId: string | null,
  ): void {
    const normalized = instanceWorldId?.trim();
    const nextInstanceWorldId = normalized && normalized.length > 0 ? normalized : null;

    if (
      this.updatePendingCreateSphere(sphereId, (sphere) => {
        sphere.instanceWorldId = nextInstanceWorldId;
      })
    ) {
      return;
    }

    for (let index = this.pendingCommitOperations.length - 1; index >= 0; index -= 1) {
      const operation = this.pendingCommitOperations[index];
      if (operation.type === "updateInstanceWorld" && operation.sphereId === sphereId) {
        operation.instanceWorldId = nextInstanceWorldId;
        return;
      }
    }

    this.pendingCommitOperations.push({
      type: "updateInstanceWorld",
      sphereId,
      instanceWorldId: nextInstanceWorldId,
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
    return Math.max(
      TEMPLATE_NONE_ID,
      resolveTemplateIdFromEntity(entity) ?? TEMPLATE_NONE_ID,
    );
  }

  private isTemplateRootSphere(entity: SphereEntity): boolean {
    return entity.tags.includes(TEMPLATE_ROOT_TAG);
  }

  private getActiveTemplateContextSphereId(): string | null {
    const activeParent = this.worldStore.getParentSphere();
    return this.isTemplateRootSphere(activeParent) ? activeParent.id : null;
  }

  private getMultiplayerWorldContext(): MultiplayerWorldContext | null {
    const contextSphereId = this.getActiveTemplateContextSphereId();
    if (!contextSphereId) {
      return null;
    }

    return {
      root_world_id: this.currentWorldId,
      instance_path: [contextSphereId],
    };
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

  private readTemplateRotationDimension(hostSphere: SphereEntity, dimension: string): number {
    const value = hostSphere.dimensions[dimension];
    return Number.isFinite(value) ? value : 0;
  }

  private rotateTemplateOffsetByHost(
    hostSphere: SphereEntity,
    offsetX: number,
    offsetY: number,
    offsetZ: number,
  ): [number, number, number] {
    const yaw = this.readTemplateRotationDimension(hostSphere, SUBWORLD_YAW_DIMENSION);
    const pitch = this.readTemplateRotationDimension(hostSphere, SUBWORLD_PITCH_DIMENSION);
    if (yaw === 0 && pitch === 0) {
      return [offsetX, offsetY, offsetZ];
    }

    this.templateRotationEuler.set(pitch, yaw, 0, "YXZ");
    this.templateRotationOffset.set(offsetX, offsetY, offsetZ).applyEuler(this.templateRotationEuler);
    return [
      this.templateRotationOffset.x,
      this.templateRotationOffset.y,
      this.templateRotationOffset.z,
    ];
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
        const [rotatedOffsetX, rotatedOffsetY, rotatedOffsetZ] =
          this.rotateTemplateOffsetByHost(
            hostSphere,
            offsetX * hostScale,
            offsetY * hostScale,
            offsetZ * hostScale,
          );

        derived.push({
          id: `${hostSphere.id}::template-${templateId}::entity-${templateChild.id}`,
          parentId: hostSphere.id,
          radius: Math.max(0.05, templateChild.radius * hostScale),
          position3d: [
            hostSphere.position3d[0] + rotatedOffsetX,
            hostSphere.position3d[1] + rotatedOffsetY,
            hostSphere.position3d[2] + rotatedOffsetZ,
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

  private ensureInstancedWorldLoaded(worldIdInput: string): void {
    const worldId = worldIdInput.trim();
    if (worldId.length === 0 || worldId === this.currentWorldId) {
      return;
    }
    if (this.instancedWorldById.has(worldId) || this.instancedWorldLoadInFlight.has(worldId)) {
      return;
    }

    this.instancedWorldLoadInFlight.add(worldId);
    void fetchWorldSeed(worldId, this.userId)
      .then((loaded) => {
        if (this.disposed) {
          return;
        }

        this.instancedWorldById.set(worldId, {
          parent: cloneSphereEntity(loaded.world.parent),
          children: loaded.world.children.map((entity) => cloneSphereEntity(entity)),
        });
        this.syncObstaclesFromSnapshot(this.worldStore.getSnapshot());
      })
      .catch((error) => {
        if (!this.disposed) {
          console.warn(`Failed to load instanced world "${worldId}"`, error);
        }
      })
      .finally(() => {
        this.instancedWorldLoadInFlight.delete(worldId);
      });
  }

  private instantiateReferencedWorldChildren(hostSpheres: SphereEntity[]): SphereEntity[] {
    const derived: SphereEntity[] = [];

    for (const hostSphere of hostSpheres) {
      const referencedWorldId = hostSphere.instanceWorldId?.trim();
      if (!referencedWorldId || referencedWorldId === this.currentWorldId) {
        continue;
      }

      const referencedWorld = this.instancedWorldById.get(referencedWorldId);
      if (!referencedWorld) {
        this.ensureInstancedWorldLoaded(referencedWorldId);
        continue;
      }

      const referencedRoot = referencedWorld.parent;
      const hostScale = this.resolveTemplateHostScale(hostSphere, referencedRoot.radius);
      if (hostScale <= 0) {
        continue;
      }

      for (const referencedChild of referencedWorld.children) {
        const offsetX = referencedChild.position3d[0] - referencedRoot.position3d[0];
        const offsetY = referencedChild.position3d[1] - referencedRoot.position3d[1];
        const offsetZ = referencedChild.position3d[2] - referencedRoot.position3d[2];
        const [rotatedOffsetX, rotatedOffsetY, rotatedOffsetZ] =
          this.rotateTemplateOffsetByHost(
            hostSphere,
            offsetX * hostScale,
            offsetY * hostScale,
            offsetZ * hostScale,
          );

        derived.push({
          id: `${hostSphere.id}::world-${referencedWorldId}::entity-${referencedChild.id}`,
          parentId: hostSphere.id,
          radius: Math.max(0.05, referencedChild.radius * hostScale),
          position3d: [
            hostSphere.position3d[0] + rotatedOffsetX,
            hostSphere.position3d[1] + rotatedOffsetY,
            hostSphere.position3d[2] + rotatedOffsetZ,
          ],
          dimensions: { ...referencedChild.dimensions },
          timeWindow: { ...hostSphere.timeWindow },
          tags: [
            ...referencedChild.tags.filter(
              (tag) =>
                tag !== TEMPLATE_DEFINITION_TAG &&
                tag !== TEMPLATE_ROOT_TAG &&
                tag !== "instanced-subworld",
            ),
            "instanced-subworld",
            `world-instance-${referencedWorldId}`,
          ],
        });
      }
    }

    return derived;
  }

  private normalizeInstanceWorldIdChoice(instanceWorldId: string | null | undefined): string | null {
    const normalized = instanceWorldId?.trim();
    if (!normalized || normalized.length === 0) {
      return null;
    }

    // Prevent self-recursive world references from the editor picker.
    if (normalized === this.currentWorldId) {
      return null;
    }

    return normalized;
  }

  private listInstanceWorldChoices(
    extras: Array<string | null | undefined> = [],
  ): string[] {
    const values: string[] = [];
    const seen = new Set<string>();
    const pushValue = (value: string | null | undefined): void => {
      const normalized = this.normalizeInstanceWorldIdChoice(value);
      if (!normalized || seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      values.push(normalized);
    };

    for (const worldId of this.availableWorldIds) {
      pushValue(worldId);
    }
    for (const extraValue of extras) {
      pushValue(extraValue);
    }

    return values;
  }

  private setCreateInstanceWorldId(instanceWorldId: string | null): void {
    const normalized = this.normalizeInstanceWorldIdChoice(instanceWorldId);
    this.createInstanceWorldId = normalized;
    this.createTemplateId =
      decodeTemplateIdFromInstanceWorldId(normalized) ?? TEMPLATE_NONE_ID;
    this.updateTemplateHud();
  }

  private setSelectedSphereInstanceWorldId(instanceWorldId: string | null): void {
    if (!this.editorMode) {
      return;
    }

    const selectedSphere = this.getSelectedEditableSphere();
    if (!selectedSphere) {
      return;
    }

    const nextInstanceWorldId = this.normalizeInstanceWorldIdChoice(instanceWorldId);
    const nextTemplateId =
      decodeTemplateIdFromInstanceWorldId(nextInstanceWorldId) ?? TEMPLATE_NONE_ID;

    const dimensionsChanged = this.worldStore.apply({
      type: "updateSphereDimensions",
      sphereId: selectedSphere.id,
      dimensions: {
        [SUBWORLD_TEMPLATE_DIMENSION]: nextTemplateId,
      },
    });
    const instanceWorldChanged = this.worldStore.apply({
      type: "updateSphereInstanceWorld",
      sphereId: selectedSphere.id,
      instanceWorldId: nextInstanceWorldId,
    });

    if (!dimensionsChanged && !instanceWorldChanged) {
      return;
    }

    if (dimensionsChanged) {
      this.queueUpdateDimensionsOperation(selectedSphere.id, {
        [SUBWORLD_TEMPLATE_DIMENSION]: nextTemplateId,
      });
    }
    if (instanceWorldChanged) {
      this.queueUpdateInstanceWorldOperation(selectedSphere.id, nextInstanceWorldId);
    }
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
    const normalizedCreateInstanceWorldId = this.normalizeInstanceWorldIdChoice(
      this.createInstanceWorldId,
    );
    if (normalizedCreateInstanceWorldId !== this.createInstanceWorldId) {
      this.createInstanceWorldId = normalizedCreateInstanceWorldId;
      this.createTemplateId =
        decodeTemplateIdFromInstanceWorldId(normalizedCreateInstanceWorldId) ??
        TEMPLATE_NONE_ID;
    }

    const selectedSphere = this.getSelectedEditableSphere();
    const selectedInstanceWorldId = selectedSphere
      ? this.normalizeInstanceWorldIdChoice(selectedSphere.instanceWorldId)
      : undefined;
    const selectedSphereColor = this.readSphereColorChannels(selectedSphere);
    const availableInstanceWorldIds = this.listInstanceWorldChoices([
      normalizedCreateInstanceWorldId,
      selectedInstanceWorldId,
    ]);

    this.templateHudPanel.render({
      editorMode: this.editorMode,
      createInstanceWorldId: normalizedCreateInstanceWorldId,
      selectedInstanceWorldId,
      availableInstanceWorldIds,
      avatarLabel: avatarLabel(this.selectedAvatarId),
      selectedColorValue: this.encodeColorInputValue(selectedSphereColor),
    });
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

  private resolveSelectedSphereTargetWorldId(selectedSphere: SphereEntity): string | null {
    const directReference = selectedSphere.instanceWorldId?.trim();
    if (directReference) {
      return directReference;
    }

    const templateId = this.readTemplateId(selectedSphere);
    if (templateId > TEMPLATE_NONE_ID) {
      return `world-template-${templateId}`;
    }

    return null;
  }

  private async handleEnterOrExitWorldShortcut(): Promise<void> {
    const selectedSphere = this.getSelectedEditableSphere();
    if (selectedSphere) {
      const targetWorldId = this.resolveSelectedSphereTargetWorldId(selectedSphere);
      if (targetWorldId && targetWorldId !== this.currentWorldId) {
        if (this.worldNavigationStack[this.worldNavigationStack.length - 1] !== this.currentWorldId) {
          this.worldNavigationStack.push(this.currentWorldId);
        }
        this.setCreateInstanceWorldId(null);
        this.stopDraggingSphere();
        await this.selectWorldLevel(targetWorldId, true);
        return;
      }
    }

    const previousWorldId = this.worldNavigationStack.pop();
    if (!previousWorldId || previousWorldId === this.currentWorldId) {
      return;
    }

    this.stopDraggingSphere();
    await this.selectWorldLevel(previousWorldId, true);
  }

  private stopDraggingSphere(): void {
    this.editorInteractionController.stopDraggingSphere();
  }

  private updateDraggedSphere(orientation: { yaw: number; pitch: number }): void {
    this.editorInteractionController.updateDraggedSphere(orientation);
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

    for (const instancedChild of this.instantiateReferencedWorldChildren(templateHosts)) {
      pushExpanded(instancedChild);
    }

    const fallbackTemplateHosts = templateHosts.filter((host) => {
      if (host.instanceWorldId?.trim()) {
        return false;
      }
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
      const hasInstanceWorldReference =
        typeof entity.instanceWorldId === "string" && entity.instanceWorldId.trim().length > 0;
      const colorChannels = this.readSphereColorChannels(entity);
      const portalHost =
        entity.parentId === snapshot.parent.id &&
        ((Number.isFinite(templateId) && Math.trunc(templateId) > TEMPLATE_NONE_ID) ||
          hasInstanceWorldReference);
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
        this.maybeStartTemplatePlacementPlayback(entity, body);
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
    this.localPredictionReconciler.reset();
    this.remoteAvatarRenderSystem.reset();

    this.multiplayerClient.connect({
      userId: this.userId,
      worldId,
      avatarId: this.selectedAvatarId,
      worldContext: this.getMultiplayerWorldContext(),
      callbacks: {
        onStatus: (status) => {
          this.multiplayerStatus = status;
          if (status === "disconnected") {
            this.localPlayerId = null;
            this.remoteAvatarRenderSystem.reset();
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
        onServerReset: (notice) => {
          void this.handleMultiplayerServerReset(notice);
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

    this.localPredictionReconciler.applySnapshot(snapshot, this.localPlayerId);
    this.remoteAvatarRenderSystem.applySnapshot(
      snapshot.players,
      this.localPlayerId,
      snapshot.server_tick,
    );
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
      this.levelLifecycleController.applyMultiplayerWorldCommit(
        commit.commit_id,
        commit.saved_to,
        loaded.tick,
      );
      this.multiplayerError = null;
    } catch (error) {
      this.multiplayerError =
        error instanceof Error
          ? `world sync failed: ${error.message}`
          : "world sync failed: unknown error";
    }
  }

  private async handleMultiplayerServerReset(
    notice: MultiplayerServerResetNotice,
  ): Promise<void> {
    if (this.serverResetReloadInFlight) {
      return;
    }

    this.serverResetReloadInFlight = true;
    this.multiplayerError = `server reset: ${notice.reason}`;

    try {
      await this.levelLifecycleController.refreshAvailableWorldIds({
        preserveCurrentWorldId: false,
      });
      if (this.disposed) {
        return;
      }

      await this.levelLifecycleController.selectWorldLevel(notice.world_id, true);
      if (!this.disposed) {
        this.multiplayerError = null;
      }
    } catch (error) {
      if (this.disposed) {
        return;
      }

      this.multiplayerError =
        error instanceof Error
          ? `server reset reload failed: ${error.message}`
          : "server reset reload failed";
    } finally {
      this.serverResetReloadInFlight = false;
    }
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
    this.templatePlacementPlaybackById.delete(obstacleId);

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
    const pointerLocked = this.controller.isPointerLocked();
    this.gameplayHudPanel.setPointerLocked(pointerLocked);
    if (!pointerLocked) {
      this.editorInteractionController.setTemplateRotateHeld(false);
      this.controller.setLookSuppressed(false);
    }
  };

  private isEditorHudTarget(target: EventTarget | null): boolean {
    return (
      target instanceof Node &&
      (this.templateHudPanel.contains(target) || this.levelSelectPanel.rootNode.contains(target))
    );
  }

  private readonly onSelectedColorInput = (inputValue: string): void => {
    if (!this.editorMode) {
      return;
    }

    const selectedSphere = this.getSelectedEditableSphere();
    if (!selectedSphere) {
      return;
    }

    const parsedColor = this.parseColorInputValue(inputValue);
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
    this.editorInteractionController.handleWheel(event);
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    this.editorInteractionController.handleMouseDown(event);
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    this.editorInteractionController.handleMouseUp(event);
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    this.editorInteractionController.handleContextMenu(event);
  };

  private readonly onWindowBlur = (): void => {
    this.editorInteractionController.handleWindowBlur();
    this.controller.setLookSuppressed(false);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.code === "KeyR" && !event.repeat && !event.isComposing && this.editorMode) {
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]")) {
        return;
      }

      event.preventDefault();
      this.editorInteractionController.setTemplateRotateHeld(true);
      this.controller.setLookSuppressed(this.editorInteractionController.isTemplateRotationActive);
      return;
    }

    this.editorKeyboardController.handleKeyDown(event);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== "KeyR") {
      return;
    }

    this.editorInteractionController.setTemplateRotateHeld(false);
    this.controller.setLookSuppressed(false);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    this.editorInteractionController.handleMouseMove(event);
    this.controller.setLookSuppressed(this.editorInteractionController.isTemplateRotationActive);
  };

  private readonly animate = (): void => {
    const frameSeconds = Math.min(this.clock.getDelta(), 0.05);
    this.accumulatorSeconds += frameSeconds;

    while (this.accumulatorSeconds >= FIXED_STEP_SECONDS) {
      this.updateFixed(FIXED_STEP_SECONDS);
      this.accumulatorSeconds -= FIXED_STEP_SECONDS;
    }

    this.remoteAvatarRenderSystem.updateInterpolation(frameSeconds);
    this.updateTemplatePlacementPlayback();
    this.syncCamera();
    this.updateHud();
    this.renderer.render(this.scene, this.camera);
  };

  private maybeStartTemplatePlacementPlayback(
    entity: SphereEntity,
    obstacle: ObstacleBody,
  ): void {
    if (this.templatePlacementPlaybackById.has(entity.id)) {
      return;
    }
    if (
      !obstacle.portalHost ||
      obstacle.instancedSubworld ||
      !entity.tags.includes("world-instance") ||
      !entity.tags.includes("user-created") ||
      this.isTemplateRootSphere(entity)
    ) {
      return;
    }

    const startTick = Math.max(0, Math.trunc(entity.timeWindow.start));
    const progress = templatePlacementPlaybackProgress({
      currentTick: this.tick,
      startTick,
      durationTicks: TEMPLATE_PLACEMENT_PLAYBACK_DURATION_TICKS,
      maxAgeTicks: TEMPLATE_PLACEMENT_PLAYBACK_MAX_AGE_TICKS,
    });
    if (progress === null) {
      return;
    }

    this.templatePlacementPlaybackById.set(entity.id, { startTick });
  }

  private updateTemplatePlacementPlayback(): void {
    if (this.templatePlacementPlaybackById.size === 0) {
      return;
    }

    for (const [obstacleId, playbackState] of this.templatePlacementPlaybackById) {
      const obstacle = this.obstacleBodiesById.get(obstacleId);
      const mesh = this.obstacleMeshes.get(obstacleId);
      if (!obstacle || !mesh) {
        this.templatePlacementPlaybackById.delete(obstacleId);
        continue;
      }

      const progress = templatePlacementPlaybackProgress({
        currentTick: this.tick,
        startTick: playbackState.startTick,
        durationTicks: TEMPLATE_PLACEMENT_PLAYBACK_DURATION_TICKS,
        maxAgeTicks: TEMPLATE_PLACEMENT_PLAYBACK_MAX_AGE_TICKS,
      });
      if (progress === null) {
        mesh.scale.setScalar(obstacle.radius);
        this.templatePlacementPlaybackById.delete(obstacleId);
        continue;
      }

      const scale = obstacle.radius * templatePlacementPlaybackScale(progress);
      mesh.scale.setScalar(scale);
      if (mesh.material instanceof THREE.MeshStandardMaterial && obstacle.portalHost) {
        mesh.material.opacity = THREE.MathUtils.lerp(0.05, 0.24, progress);
      }

      if (progress >= 1) {
        mesh.scale.setScalar(obstacle.radius);
        if (mesh.material instanceof THREE.MeshStandardMaterial && obstacle.portalHost) {
          mesh.material.opacity = 0.24;
        }
        this.templatePlacementPlaybackById.delete(obstacleId);
      }
    }
  }

  private sendLocalPlayerUpdate(options: { recordPrediction: boolean } = { recordPrediction: true }): void {
    const orientation = this.controller.getOrientation();
    const inputSequence = this.nextPlayerInputSequence();

    if (options.recordPrediction) {
      this.localPredictionReconciler.recordPredictedInput({
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
      this.getMultiplayerWorldContext(),
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
    if (!this.editorMode) {
      this.editorInteractionController.setTemplateRotateHeld(false);
      this.controller.setLookSuppressed(false);
    }
    if (this.parentMesh) {
      this.parentMesh.visible = this.editorMode;
    }
    if (!this.editorMode) {
      this.stopDraggingSphere();
      this.worldStore.apply({ type: "deselectSphere" });
    }
    this.gameplayHudPanel.renderHint(this.editorMode);
    this.updateTemplateHud();
    this.updateLevelSelectHud();
    this.recolorObstacles();
  }

  private updateHud(): void {
    this.gameplayHudPanel.renderDebug({
      editorMode: this.editorMode,
      tick: this.tick,
      playerPosition: this.player.position,
      playerVelocity: this.player.velocity,
      playerGrounded: this.player.grounded,
      lastCollisionCount: this.lastCollisionCount,
      overlayEnabled: this.overlayEnabled,
      draggingSphereId: this.editorInteractionController.currentDraggingSphereId,
      createTemplateId: this.createTemplateId,
      selectedAvatarId: this.selectedAvatarId,
      selectedSphereId: this.worldStore.getSelectedSphereId(),
      currentWorldId: this.currentWorldId,
      availableWorldCount: this.availableWorldIds.length,
      parentSphereId: this.parentSphere.id,
      obstacleCount: this.obstacles.length,
      worldSourceState: this.worldSourceState,
      backendWorldTick: this.backendWorldTick,
      pendingCommitCount: this.pendingCommitOperations.length,
      saveMessage: this.saveMessage,
      userId: this.userId,
      multiplayerStatus: this.multiplayerStatus,
      localPlayerId: this.localPlayerId,
      remotePlayerCount: this.remoteAvatarRenderSystem.remotePlayerCount,
      ackedInputSequence: this.localPredictionReconciler.ackedInputSequence,
      pendingPredictedInputCount: this.localPredictionReconciler.pendingPredictedInputCount,
      lastSnapshotTick: this.localPredictionReconciler.lastSnapshotTick,
      reconciliationErrorDistance: this.localPredictionReconciler.lastReconciliationErrorDistance,
      multiplayerError: this.multiplayerError,
    });
  }
}
