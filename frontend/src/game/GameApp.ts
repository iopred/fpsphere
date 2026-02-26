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
import { buildSeedWorld } from "./worldSeed";
import {
  commitWorldChanges,
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
const WORLD_ID = "world-main";
const REMOTE_PLAYER_RADIUS = 0.9;
const NETWORK_SEND_INTERVAL_TICKS = 2;

const tempForward = new THREE.Vector3();
const tempOffset = new THREE.Vector3();
const tempRaycastPoint = new THREE.Vector2(0, 0);

export class GameApp {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly clock = new THREE.Clock();
  private readonly hudNode: HTMLDivElement;
  private readonly hintNode: HTMLDivElement;
  private readonly crosshairNode: HTMLDivElement;

  private readonly controller: FpsController;
  private readonly worldStore = new LocalWorldStore(buildSeedWorld());
  private readonly parentSphere = this.worldStore.getParentSphere();

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
  private readonly remotePlayers = new Map<string, RemotePlayerState>();
  private readonly remotePlayerMeshes = new Map<string, THREE.Mesh>();
  private readonly raycaster = new THREE.Raycaster();
  private obstacles: ObstacleBody[] = [];
  private unsubscribeWorldStore: (() => void) | null = null;
  private accumulatorSeconds = 0;
  private tick = 0;
  private lastCollisionCount = 0;
  private overlayEnabled = false;
  private editorMode = false;
  private createdSphereCount = 0;
  private pendingCommitOperations: WorldCommitOperation[] = [];
  private saveInFlight = false;
  private saveMessage = "no pending edits";
  private backendWorldTick = 0;
  private readonly userId = this.getOrCreateUserId();
  private localPlayerId: string | null = null;
  private multiplayerStatus = "disconnected";
  private multiplayerError: string | null = null;
  private lastNetworkSendTick = 0;
  private worldSourceState: "seed" | "loading" | "backend" | "backend-user" = "loading";
  private disposed = false;

  constructor(private readonly mountNode: HTMLDivElement) {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.mountNode.appendChild(this.renderer.domElement);

    this.hudNode = document.createElement("div");
    this.hudNode.className = "hud";
    this.mountNode.appendChild(this.hudNode);

    this.hintNode = document.createElement("div");
    this.hintNode.className = "center-hint";
    this.mountNode.appendChild(this.hintNode);

    this.crosshairNode = document.createElement("div");
    this.crosshairNode.className = "crosshair";
    this.mountNode.appendChild(this.crosshairNode);

    this.controller = new FpsController(this.renderer.domElement);

    this.setupScene();
    this.connectMultiplayer();
    this.unsubscribeWorldStore = this.worldStore.subscribe(this.onWorldStoreChanged);
    this.updateHintText();
    this.recolorObstacles();
    void this.loadWorldFromBackend(WORLD_ID);

    window.addEventListener("resize", this.onResize);
    document.addEventListener("pointerlockchange", this.onPointerLockChange);
    document.addEventListener("keydown", this.onKeyDown);
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

    const parentGeometry = new THREE.SphereGeometry(this.parentSphere.radius, 48, 32);
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
    this.scene.add(parentMesh);
    this.worldMeshes.set(this.parentSphere.id, parentMesh);

    this.syncObstaclesFromSnapshot(this.worldStore.getSnapshot());
  }

  private buildObstacleBody(entity: SphereEntity): ObstacleBody {
    return {
      id: entity.id,
      center: new THREE.Vector3(entity.position3d[0], entity.position3d[1], entity.position3d[2]),
      radius: entity.radius,
      money: entity.dimensions.money ?? 0,
    };
  }

  private readonly onWorldStoreChanged = (snapshot: WorldStoreSnapshot): void => {
    this.parentCenter.set(
      snapshot.parent.position3d[0],
      snapshot.parent.position3d[1],
      snapshot.parent.position3d[2],
    );
    const parentMesh = this.worldMeshes.get(this.parentSphere.id);
    if (parentMesh) {
      parentMesh.position.copy(this.parentCenter);
    }
    this.syncObstaclesFromSnapshot(snapshot);
  };

  private async loadWorldFromBackend(worldId: string): Promise<void> {
    this.worldSourceState = "loading";

    try {
      const loadedWorld = await fetchWorldSeed(worldId, this.userId);
      if (this.disposed) {
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
    } catch (error) {
      this.worldSourceState = "seed";
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

    try {
      const response = await commitWorldChanges({
        worldId: WORLD_ID,
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

  private syncObstaclesFromSnapshot(snapshot: WorldStoreSnapshot): void {
    const nextIds = new Set<string>();

    for (const entity of snapshot.children) {
      nextIds.add(entity.id);

      const existingBody = this.obstacleBodiesById.get(entity.id);
      if (!existingBody) {
        const body = this.buildObstacleBody(entity);
        this.obstacleBodiesById.set(entity.id, body);
        this.addObstacleMesh(body);
        continue;
      }

      existingBody.center.set(entity.position3d[0], entity.position3d[1], entity.position3d[2]);
      existingBody.radius = entity.radius;
      existingBody.money = entity.dimensions.money ?? 0;

      const existingMesh = this.obstacleMeshes.get(entity.id);
      if (existingMesh) {
        existingMesh.position.copy(existingBody.center);
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

  private connectMultiplayer(): void {
    this.multiplayerClient.connect({
      userId: this.userId,
      worldId: WORLD_ID,
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
    if (snapshot.world_id !== WORLD_ID) {
      return;
    }

    const nextIds = new Set<string>();
    for (const remotePlayer of snapshot.players) {
      if (remotePlayer.player_id === this.localPlayerId) {
        continue;
      }

      nextIds.add(remotePlayer.player_id);
      this.remotePlayers.set(remotePlayer.player_id, remotePlayer);
      this.upsertRemotePlayerMesh(remotePlayer);
    }

    for (const existingId of [...this.remotePlayers.keys()]) {
      if (nextIds.has(existingId)) {
        continue;
      }
      this.remotePlayers.delete(existingId);
      this.removeRemotePlayerMesh(existingId);
    }
  }

  private applyMultiplayerWorldCommit(commit: MultiplayerWorldCommit): void {
    if (commit.world_id !== WORLD_ID) {
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

  private upsertRemotePlayerMesh(remotePlayer: RemotePlayerState): void {
    const existingMesh = this.remotePlayerMeshes.get(remotePlayer.player_id);
    if (existingMesh) {
      existingMesh.position.set(
        remotePlayer.position_3d[0],
        remotePlayer.position_3d[1],
        remotePlayer.position_3d[2],
      );
      return;
    }

    const geometry = new THREE.SphereGeometry(REMOTE_PLAYER_RADIUS, 18, 14);
    const material = new THREE.MeshStandardMaterial({
      color: 0x4be29f,
      emissive: 0x0d5e43,
      roughness: 0.45,
      metalness: 0.2,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(
      remotePlayer.position_3d[0],
      remotePlayer.position_3d[1],
      remotePlayer.position_3d[2],
    );
    this.scene.add(mesh);
    this.remotePlayerMeshes.set(remotePlayer.player_id, mesh);
  }

  private removeRemotePlayerMesh(playerId: string): void {
    const mesh = this.remotePlayerMeshes.get(playerId);
    if (!mesh) {
      return;
    }

    this.scene.remove(mesh);
    mesh.geometry.dispose();
    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) {
        material.dispose();
      }
    } else {
      mesh.material.dispose();
    }
    this.remotePlayerMeshes.delete(playerId);
  }

  private clearRemotePlayers(): void {
    for (const playerId of [...this.remotePlayerMeshes.keys()]) {
      this.removeRemotePlayerMesh(playerId);
    }
    this.remotePlayers.clear();
  }

  private addObstacleMesh(obstacle: ObstacleBody): void {
    const sphereGeometry = new THREE.SphereGeometry(obstacle.radius, 24, 18);
    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0x7082a1,
      roughness: 0.75,
      metalness: 0.08,
    });
    const obstacleMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
    obstacleMesh.position.copy(obstacle.center);
    obstacleMesh.userData.sphereId = obstacle.id;
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

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void this.saveWorldCommit();
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
      this.worldStore.apply({ type: "deselectSphere" });
      return;
    }

    if (matchesKeyBinding(event, KEYBINDINGS.selectLookedAtSphere)) {
      event.preventDefault();
      this.selectSphereAtReticle();
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

    this.syncCamera();
    this.updateHud();
    this.renderer.render(this.scene, this.camera);
  };

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
      this.player.velocity.multiplyScalar(1 / (1 + DRAG_GROUNDED * dt));
      if (input.jump) {
        this.player.velocity.y = JUMP_SPEED;
        this.player.grounded = false;
      }
    } else {
      const targetX = moveDirection.x * MOVE_SPEED;
      const targetZ = moveDirection.z * MOVE_SPEED;
      this.player.velocity.x += (targetX - this.player.velocity.x) * AIR_CONTROL * dt;
      this.player.velocity.z += (targetZ - this.player.velocity.z) * AIR_CONTROL * dt;
      this.player.velocity.multiplyScalar(1 / (1 + DRAG_AIR * dt));
    }

    this.player.velocity.y -= GRAVITY * dt;
    this.player.position.addScaledVector(this.player.velocity, dt);

    this.lastCollisionCount = resolveSphereCollisions(this.player, this.obstacles);
    constrainInsideParentSphere(this.player, this.parentCenter, this.parentSphere.radius);

    if (this.tick - this.lastNetworkSendTick >= NETWORK_SEND_INTERVAL_TICKS) {
      const orientation = this.controller.getOrientation();
      this.multiplayerClient.sendPlayerUpdate(
        [this.player.position.x, this.player.position.y, this.player.position.z],
        orientation.yaw,
        orientation.pitch,
        this.tick,
      );
      this.lastNetworkSendTick = this.tick;
    }
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

      const baseColor = new THREE.Color(0x78849b);
      const overlayColor = new THREE.Color(0x2f7aff);
      const blend = this.overlayEnabled ? Math.max(0, Math.min(1, obstacle.money)) : 0;
      obstacleMesh.material.color.copy(baseColor).lerp(overlayColor, blend);
      obstacleMesh.material.emissive.setHex(0x000000).lerp(new THREE.Color(0x103a8f), blend * 0.35);

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
      this.worldStore.apply({ type: "deselectSphere" });
    }
    this.updateHintText();
  }

  private createSphereInFrontOfPlayer(): void {
    this.createdSphereCount += 1;
    const id = `sphere-user-${String(this.createdSphereCount).padStart(3, "0")}`;
    this.camera.getWorldDirection(tempForward);

    const center = this.player.position
      .clone()
      .addScaledVector(tempForward.normalize(), CREATE_DISTANCE);

    tempOffset.copy(center).sub(this.parentCenter);
    const distanceFromCenter = tempOffset.length();
    const maxDistance = this.parentSphere.radius - CREATED_SPHERE_RADIUS - CREATE_BOUNDARY_MARGIN;
    if (distanceFromCenter > maxDistance) {
      if (distanceFromCenter > 1e-6) {
        center.copy(this.parentCenter).addScaledVector(tempOffset.normalize(), maxDistance);
      } else {
        center.copy(this.parentCenter).add(new THREE.Vector3(0, 0, maxDistance));
      }
    }

    const sphere: SphereEntity = {
      id,
      parentId: this.parentSphere.id,
      radius: CREATED_SPHERE_RADIUS,
      position3d: [center.x, center.y, center.z],
      dimensions: {
        money: Math.random(),
      },
      timeWindow: {
        start: this.tick,
        end: null,
      },
      tags: ["user-created"],
    };

    const changed = this.worldStore.apply({
      type: "createSphere",
      selectCreated: true,
      sphere,
    });

    if (changed) {
      this.pendingCommitOperations.push({
        type: "create",
        sphere,
      });
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

    const firstObject = intersections[0].object as THREE.Mesh;
    const selectedId = firstObject.userData.sphereId;
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
        "EDIT MODE | ~ exit | C create | E select looked-at | Q deselect | Z delete selected";
      return;
    }

    this.hintNode.textContent =
      "Click to lock pointer | WASD + Space | O overlay | ~ editor mode | Cmd/Ctrl+S save";
  }

  private updateHud(): void {
    const selectedSphereId = this.worldStore.getSelectedSphereId();

    this.hudNode.textContent =
      `tick: ${this.tick}\n` +
      `position: ${this.player.position.x.toFixed(2)}, ${this.player.position.y.toFixed(2)}, ${this.player.position.z.toFixed(2)}\n` +
      `velocity: ${this.player.velocity.x.toFixed(2)}, ${this.player.velocity.y.toFixed(2)}, ${this.player.velocity.z.toFixed(2)}\n` +
      `grounded: ${this.player.grounded ? "yes" : "no"}\n` +
      `collisions: ${this.lastCollisionCount}\n` +
      `overlay: ${this.overlayEnabled ? "money (blue)" : "off"}\n` +
      `editor: ${this.editorMode ? "on" : "off"}\n` +
      `selected: ${selectedSphereId ?? "none"}\n` +
      `spheres: ${this.obstacles.length}\n` +
      `world source: ${this.worldSourceState}\n` +
      `world tick: ${this.backendWorldTick}\n` +
      `pending edits: ${this.pendingCommitOperations.length}\n` +
      `save: ${this.saveMessage}\n` +
      `user: ${this.userId}\n` +
      `multiplayer: ${this.multiplayerStatus}\n` +
      `player id: ${this.localPlayerId ?? "pending"}\n` +
      `remote players: ${this.remotePlayers.size}\n` +
      `mp error: ${this.multiplayerError ?? "none"}`;
  }
}
