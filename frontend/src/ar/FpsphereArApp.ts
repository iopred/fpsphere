import * as THREE from "three";
import type { SphereEntity } from "@fpsphere/shared-types";
import { fetchWorldSeed, parseLoadedWorldSnapshot } from "../game/worldApi";
import { buildSeedWorld } from "../game/worldSeed";
import {
  MultiplayerClient,
  type MultiplayerSnapshot,
  type MultiplayerWorldCommit,
  type RemotePlayerState,
} from "../game/multiplayerClient";
import {
  createRemoteAvatarHandle,
  type AvatarRenderHandle,
} from "../game/avatarRenderAdapter";
import { LocalWorldStore, type WorldStoreSnapshot } from "../game/worldStore";
import {
  getTemplateRootSphereId,
  instantiateSubworldChildren,
  SUBWORLD_SCALE_DIMENSION,
  SUBWORLD_TEMPLATE_DIMENSION,
  TEMPLATE_DEFINITION_TAG,
  TEMPLATE_ROOT_TAG,
} from "../game/subworldTemplates";
import {
  DEFAULT_MARKER_SIZE_METERS,
  DEFAULT_WORLD_SCALE_MULTIPLIER,
  DEFAULT_WORLD_ID,
  parseMarkerPayload,
} from "./markerPayload";
import { estimateMarkerPose, type CornerPoint } from "./qrPose";

const AR_CAMERA_FOV_DEGREES = 62;
const DETECTION_INTERVAL_MS = 110;
const MARKER_LOST_AFTER_MS = 700;
const POSE_LERP_FACTOR = 0.35;
const POSE_SLERP_FACTOR = 0.3;
const WORLD_RENDER_RADIUS_METERS = 0.06;
const WORLD_RENDER_LIFT_METERS = 0.045;
const JSQR_CDN_URL = "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js";
const TEMPLATE_NONE_ID = 0;

interface BarcodeCornerPointLike {
  x: number;
  y: number;
}

interface DetectedBarcodeLike {
  rawValue?: string;
  cornerPoints?: BarcodeCornerPointLike[];
  boundingBox?: Pick<DOMRectReadOnly, "x" | "y" | "width" | "height">;
}

interface BarcodeDetectorLike {
  detect(source: ImageBitmapSource): Promise<DetectedBarcodeLike[]>;
}

type BarcodeDetectorConstructor = new (options?: {
  formats?: string[];
}) => BarcodeDetectorLike;

interface WindowWithBarcodeDetector extends Window {
  BarcodeDetector?: BarcodeDetectorConstructor;
}

interface WindowWithJsQr extends Window {
  jsQR?: JsQrDecodeFunction;
}

interface JsQrLocation {
  topLeftCorner: { x: number; y: number };
  topRightCorner: { x: number; y: number };
  bottomRightCorner: { x: number; y: number };
  bottomLeftCorner: { x: number; y: number };
}

interface JsQrDecodeResult {
  data: string;
  location: JsQrLocation;
}

type JsQrDecodeFunction = (
  imageData: Uint8ClampedArray,
  width: number,
  height: number,
  options?: {
    inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
  },
) => JsQrDecodeResult | null;

interface QrDetector {
  detect(source: HTMLVideoElement): Promise<DetectedBarcodeLike[]>;
  getDescription(): string;
  dispose?(): void;
}

class NativeBarcodeQrDetector implements QrDetector {
  constructor(private readonly detector: BarcodeDetectorLike) {}

  async detect(source: HTMLVideoElement): Promise<DetectedBarcodeLike[]> {
    return this.detector.detect(source);
  }

  getDescription(): string {
    return "native BarcodeDetector";
  }
}

class JsQrFallbackDetector implements QrDetector {
  private readonly sampleCanvas = document.createElement("canvas");
  private readonly sampleContext = this.sampleCanvas.getContext("2d", {
    willReadFrequently: true,
  });

  constructor(private readonly decodeQr: JsQrDecodeFunction) {}

  async detect(source: HTMLVideoElement): Promise<DetectedBarcodeLike[]> {
    if (!this.sampleContext) {
      return [];
    }

    const sourceWidth = source.videoWidth;
    const sourceHeight = source.videoHeight;
    if (sourceWidth <= 0 || sourceHeight <= 0) {
      return [];
    }

    const targetWidth = Math.min(720, sourceWidth);
    const scale = targetWidth / sourceWidth;
    const sampleWidth = Math.max(160, Math.round(sourceWidth * scale));
    const sampleHeight = Math.max(120, Math.round(sourceHeight * scale));
    if (sampleWidth <= 0 || sampleHeight <= 0) {
      return [];
    }

    if (
      this.sampleCanvas.width !== sampleWidth ||
      this.sampleCanvas.height !== sampleHeight
    ) {
      this.sampleCanvas.width = sampleWidth;
      this.sampleCanvas.height = sampleHeight;
    }

    this.sampleContext.drawImage(source, 0, 0, sampleWidth, sampleHeight);
    const imageData = this.sampleContext.getImageData(0, 0, sampleWidth, sampleHeight);

    const decoded =
      this.decodeQr(imageData.data, sampleWidth, sampleHeight, {
        inversionAttempts: "dontInvert",
      }) ??
      this.decodeQr(imageData.data, sampleWidth, sampleHeight, {
        inversionAttempts: "attemptBoth",
      });
    if (!decoded) {
      return [];
    }

    const xScale = sourceWidth / sampleWidth;
    const yScale = sourceHeight / sampleHeight;
    const location = decoded.location;
    const points: BarcodeCornerPointLike[] = [
      location.topLeftCorner,
      location.topRightCorner,
      location.bottomRightCorner,
      location.bottomLeftCorner,
    ].map((point) => ({
      x: point.x * xScale,
      y: point.y * yScale,
    }));

    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    const maxX = Math.max(...points.map((point) => point.x));
    const maxY = Math.max(...points.map((point) => point.y));

    return [
      {
        rawValue: decoded.data,
        cornerPoints: points,
        boundingBox: {
          x: minX,
          y: minY,
          width: maxX - minX,
          height: maxY - minY,
        },
      },
    ];
  }

  getDescription(): string {
    return "jsQR fallback";
  }
}

let jsQrLoadPromise: Promise<JsQrDecodeFunction | null> | null = null;

function loadJsQrDecoder(): Promise<JsQrDecodeFunction | null> {
  const existing = (window as WindowWithJsQr).jsQR;
  if (typeof existing === "function") {
    return Promise.resolve(existing);
  }

  if (jsQrLoadPromise) {
    return jsQrLoadPromise;
  }

  jsQrLoadPromise = new Promise<JsQrDecodeFunction | null>((resolve) => {
    const scriptNode = document.createElement("script");
    scriptNode.src = JSQR_CDN_URL;
    scriptNode.async = true;
    scriptNode.crossOrigin = "anonymous";
    scriptNode.referrerPolicy = "no-referrer";

    scriptNode.onload = () => {
      const loaded = (window as WindowWithJsQr).jsQR;
      resolve(typeof loaded === "function" ? loaded : null);
    };
    scriptNode.onerror = () => {
      resolve(null);
    };

    document.head.appendChild(scriptNode);
  });

  return jsQrLoadPromise;
}

interface ArObstacle {
  id: string;
  center: THREE.Vector3;
  radius: number;
  money: number;
  portalHost: boolean;
  instancedSubworld: boolean;
}

function toCornerPoints(detection: DetectedBarcodeLike): CornerPoint[] {
  if (Array.isArray(detection.cornerPoints) && detection.cornerPoints.length >= 4) {
    return detection.cornerPoints
      .slice(0, 4)
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      .map((point) => ({ x: point.x, y: point.y }));
  }

  const bounds = detection.boundingBox;
  if (!bounds) {
    return [];
  }
  const { x, y, width, height } = bounds;
  if (
    ![x, y, width, height].every((value) => Number.isFinite(value)) ||
    width <= 0 ||
    height <= 0
  ) {
    return [];
  }

  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

export class FpsphereArApp {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(AR_CAMERA_FOV_DEGREES, 1, 0.01, 8);
  private readonly renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  private readonly markerAnchor = new THREE.Group();
  private readonly worldGroup = new THREE.Group();
  private readonly worldContentGroup = new THREE.Group();

  private readonly worldStore = new LocalWorldStore(buildSeedWorld());
  private parentSphere = this.worldStore.getParentSphere();
  private readonly parentCenter = new THREE.Vector3(
    this.parentSphere.position3d[0],
    this.parentSphere.position3d[1],
    this.parentSphere.position3d[2],
  );
  private parentMesh: THREE.Mesh | null = null;
  private readonly obstaclesById = new Map<string, ArObstacle>();
  private readonly obstacleMeshes = new Map<string, THREE.Mesh>();

  private readonly multiplayerClient = new MultiplayerClient();
  private readonly remotePlayers = new Map<string, RemotePlayerState>();
  private readonly remotePlayerAvatars = new Map<string, AvatarRenderHandle>();

  private readonly rootNode: HTMLDivElement;
  private readonly videoNode: HTMLVideoElement;
  private readonly statusNode: HTMLParagraphElement;
  private readonly startButton: HTMLButtonElement;

  private detector: QrDetector | null = null;

  private running = false;
  private animationFrameId: number | null = null;
  private detectionInFlight = false;
  private lastDetectionAtMs = 0;
  private lastMarkerSeenAtMs = 0;
  private markerPoseInitialized = false;
  private lastStatusMessage = "";
  private worldLoadVersion = 0;
  private currentWorldId: string | null = null;
  private connectedWorldId: string | null = null;
  private cameraStream: MediaStream | null = null;
  private hasReportedDetectError = false;
  private detectorSetupInFlight = false;
  private localPlayerId: string | null = null;
  private readonly userId = this.getOrCreateUserId();
  private unsubscribeWorldStore: (() => void) | null = null;
  private currentWorldScaleMultiplier = DEFAULT_WORLD_SCALE_MULTIPLIER;
  private readonly autoCenterOffset = new THREE.Vector3();

  constructor(private readonly mountNode: HTMLDivElement) {
    this.mountNode.innerHTML = "";

    this.rootNode = document.createElement("div");
    this.rootNode.className = "ar-root";
    this.mountNode.appendChild(this.rootNode);

    this.videoNode = document.createElement("video");
    this.videoNode.className = "ar-video";
    this.videoNode.autoplay = true;
    this.videoNode.muted = true;
    this.videoNode.playsInline = true;
    this.rootNode.appendChild(this.videoNode);

    this.renderer.domElement.className = "ar-canvas";
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.rootNode.appendChild(this.renderer.domElement);

    const overlayNode = document.createElement("div");
    overlayNode.className = "ar-overlay";
    this.rootNode.appendChild(overlayNode);

    const titleNode = document.createElement("h1");
    titleNode.className = "ar-title";
    titleNode.textContent = "FPSphere Marker AR";
    overlayNode.appendChild(titleNode);

    this.statusNode = document.createElement("p");
    this.statusNode.className = "ar-status";
    overlayNode.appendChild(this.statusNode);

    const controlsNode = document.createElement("div");
    controlsNode.className = "ar-controls";
    overlayNode.appendChild(controlsNode);

    this.startButton = document.createElement("button");
    this.startButton.type = "button";
    this.startButton.className = "ar-button";
    this.startButton.textContent = "Start camera";
    this.startButton.addEventListener("click", () => {
      void this.startCamera();
    });
    controlsNode.appendChild(this.startButton);

    const qrLink = document.createElement("a");
    qrLink.className = "ar-link";
    qrLink.href = "/?mode=qr";
    qrLink.textContent = "Print marker";
    controlsNode.appendChild(qrLink);

    const gameLink = document.createElement("a");
    gameLink.className = "ar-link";
    gameLink.href = "/";
    gameLink.textContent = "Open FPS mode";
    controlsNode.appendChild(gameLink);

    const hintNode = document.createElement("p");
    hintNode.className = "ar-hint";
    hintNode.textContent =
      "Use a QR payload like fpsphere://world/world-main?marker=0.12.";
    overlayNode.appendChild(hintNode);

    this.setupScene();
    this.unsubscribeWorldStore = this.worldStore.subscribe(this.onWorldStoreChanged);
    this.onWorldStoreChanged(this.worldStore.getSnapshot());

    this.videoNode.addEventListener("loadedmetadata", this.onVideoMetadata);
    window.addEventListener("resize", this.onResize);
  }

  start(): void {
    this.onResize();
    this.running = true;
    this.animationFrameId = window.requestAnimationFrame(this.animate);

    const queryWorldId =
      new URLSearchParams(window.location.search).get("world") ?? DEFAULT_WORLD_ID;
    void this.loadWorld(queryWorldId);

    this.updateStatus(
      "Initializing QR scanner, then start camera and point at a printed marker.",
    );
    void this.initializeDetector();
  }

  dispose(): void {
    this.running = false;
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    window.removeEventListener("resize", this.onResize);
    this.videoNode.removeEventListener("loadedmetadata", this.onVideoMetadata);

    if (this.unsubscribeWorldStore) {
      this.unsubscribeWorldStore();
      this.unsubscribeWorldStore = null;
    }

    this.stopCameraStream();
    this.multiplayerClient.disconnect();
    this.clearRemotePlayers();
    this.clearObstacles();

    if (this.parentMesh) {
      this.worldContentGroup.remove(this.parentMesh);
      this.parentMesh.geometry.dispose();
      if (Array.isArray(this.parentMesh.material)) {
        for (const material of this.parentMesh.material) {
          material.dispose();
        }
      } else {
        this.parentMesh.material.dispose();
      }
      this.parentMesh = null;
    }

    this.detector?.dispose?.();
    this.detector = null;

    this.renderer.dispose();
  }

  private setupScene(): void {
    this.scene.background = null;

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
    this.parentMesh = new THREE.Mesh(parentGeometry, parentMaterial);
    this.parentMesh.visible = false;
    this.worldContentGroup.add(this.parentMesh);

    this.worldGroup.position.z = WORLD_RENDER_LIFT_METERS;
    this.worldContentGroup.position.copy(this.autoCenterOffset);
    this.worldGroup.add(this.worldContentGroup);
    this.markerAnchor.add(this.worldGroup);
    this.markerAnchor.visible = false;
    this.scene.add(this.markerAnchor);
  }

  private readonly onVideoMetadata = (): void => {
    this.onResize();
  };

  private readonly onResize = (): void => {
    const width = this.rootNode.clientWidth || window.innerWidth;
    const height = this.rootNode.clientHeight || window.innerHeight;
    if (width <= 0 || height <= 0) {
      return;
    }

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height);
  };

  private createNativeBarcodeDetector(): BarcodeDetectorLike | null {
    const detectorCtor = (window as WindowWithBarcodeDetector).BarcodeDetector;
    if (!detectorCtor) {
      return null;
    }

    try {
      return new detectorCtor({ formats: ["qr_code"] });
    } catch {
      try {
        return new detectorCtor();
      } catch {
        return null;
      }
    }
  }

  private async initializeDetector(): Promise<void> {
    if (this.detectorSetupInFlight || this.detector) {
      return;
    }

    this.detectorSetupInFlight = true;
    try {
      const nativeDetector = this.createNativeBarcodeDetector();
      if (nativeDetector) {
        this.detector = new NativeBarcodeQrDetector(nativeDetector);
        this.updateStatus(
          "Scanner ready (native BarcodeDetector). Start camera and scan marker.",
        );
        return;
      }

      this.updateStatus("Native scanner unavailable. Loading JS fallback scanner...");
      const jsQr = await loadJsQrDecoder();
      if (!jsQr) {
        this.updateStatus(
          "QR scanner unavailable. Could not load fallback decoder. Check network access and reload.",
        );
        return;
      }

      this.detector = new JsQrFallbackDetector(jsQr);
      this.updateStatus("Scanner ready (jsQR fallback). Start camera and scan marker.");
    } finally {
      this.detectorSetupInFlight = false;
    }
  }

  private async startCamera(): Promise<void> {
    if (this.cameraStream) {
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      if (!window.isSecureContext) {
        this.updateStatus(
          "Camera requires HTTPS in iOS browsers. Open this page via a secure https:// URL.",
        );
        return;
      }
      this.updateStatus("Camera access is unavailable in this browser.");
      return;
    }

    this.startButton.disabled = true;
    this.startButton.textContent = "Starting...";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });

      this.cameraStream = stream;
      this.videoNode.srcObject = stream;
      await this.videoNode.play();

      this.startButton.hidden = true;
      this.updateStatus("Camera active. Scan a FPSphere marker.");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown error";
      this.updateStatus(`Failed to start camera: ${reason}`);
      this.startButton.disabled = false;
      this.startButton.textContent = "Retry camera";
    }
  }

  private stopCameraStream(): void {
    if (!this.cameraStream) {
      return;
    }
    for (const track of this.cameraStream.getTracks()) {
      track.stop();
    }
    this.cameraStream = null;
    this.videoNode.srcObject = null;
  }

  private readonly animate = (): void => {
    if (!this.running) {
      return;
    }

    this.animationFrameId = window.requestAnimationFrame(this.animate);

    const now = performance.now();
    if (
      this.detector &&
      !this.detectionInFlight &&
      this.videoNode.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      this.videoNode.videoWidth > 0 &&
      this.videoNode.videoHeight > 0 &&
      now - this.lastDetectionAtMs >= DETECTION_INTERVAL_MS
    ) {
      this.lastDetectionAtMs = now;
      void this.detectMarker();
    }

    if (this.markerAnchor.visible && now - this.lastMarkerSeenAtMs > MARKER_LOST_AFTER_MS) {
      this.markerAnchor.visible = false;
      this.markerPoseInitialized = false;
      this.updateStatus("Marker lost. Keep the full QR code visible.");
    }

    this.renderer.render(this.scene, this.camera);
  };

  private async detectMarker(): Promise<void> {
    if (!this.detector) {
      return;
    }

    this.detectionInFlight = true;
    try {
      const detections = await this.detector.detect(this.videoNode);
      this.hasReportedDetectError = false;
      this.handleDetections(detections);
    } catch (error) {
      if (!this.hasReportedDetectError) {
        const reason =
          error instanceof Error ? error.message : "unknown detector error";
        this.updateStatus(`QR detection error: ${reason}`);
        this.hasReportedDetectError = true;
      }
    } finally {
      this.detectionInFlight = false;
    }
  }

  private handleDetections(detections: DetectedBarcodeLike[]): void {
    const frameWidth = this.videoNode.videoWidth;
    const frameHeight = this.videoNode.videoHeight;

    for (const detection of detections) {
      if (typeof detection.rawValue !== "string") {
        continue;
      }

      const markerPayload = parseMarkerPayload(detection.rawValue);
      if (!markerPayload) {
        continue;
      }

      const corners = toCornerPoints(detection);
      const pose = estimateMarkerPose({
        corners,
        frameWidth,
        frameHeight,
        markerSizeMeters: markerPayload.markerSizeMeters,
        fovYDegrees: AR_CAMERA_FOV_DEGREES,
      });
      if (!pose) {
        continue;
      }

      this.applyMarkerPose(
        markerPayload.worldId,
        markerPayload.markerSizeMeters,
        markerPayload.worldScaleMultiplier,
        pose.position,
        pose.quaternion,
      );
      return;
    }

    if (!this.markerAnchor.visible && this.currentWorldId) {
      this.updateStatus(`Scanning for marker (${this.currentWorldId})...`);
    }
  }

  private applyMarkerPose(
    worldId: string,
    markerSizeMeters: number,
    worldScaleMultiplier: number,
    position: THREE.Vector3,
    quaternion: THREE.Quaternion,
  ): void {
    if (this.currentWorldId !== worldId) {
      void this.loadWorld(worldId);
    }

    const scale = markerSizeMeters / DEFAULT_MARKER_SIZE_METERS;
    this.markerAnchor.scale.setScalar(scale);
    if (this.currentWorldScaleMultiplier !== worldScaleMultiplier) {
      this.currentWorldScaleMultiplier = worldScaleMultiplier;
      this.refreshWorldRenderScale();
    }

    if (!this.markerPoseInitialized) {
      this.markerAnchor.position.copy(position);
      this.markerAnchor.quaternion.copy(quaternion);
      this.markerPoseInitialized = true;
    } else {
      this.markerAnchor.position.lerp(position, POSE_LERP_FACTOR);
      this.markerAnchor.quaternion.slerp(quaternion, POSE_SLERP_FACTOR);
    }

    this.markerAnchor.visible = true;
    this.lastMarkerSeenAtMs = performance.now();
    this.updateStatus(
      `Tracking world "${worldId}" | scale: ${this.currentWorldScaleMultiplier}x | remote players: ${this.remotePlayerAvatars.size} | scanner: ${this.detector?.getDescription() ?? "unknown"}`,
    );
  }

  private async loadWorld(worldIdInput: string): Promise<void> {
    const worldId = worldIdInput.trim();
    if (worldId.length === 0) {
      return;
    }

    const requestVersion = ++this.worldLoadVersion;
    this.currentWorldId = worldId;
    this.connectMultiplayer(worldId);
    this.updateStatus(`Loading world "${worldId}"...`);

    try {
      const loaded = await fetchWorldSeed(worldId);
      if (requestVersion !== this.worldLoadVersion) {
        return;
      }

      this.worldStore.apply({
        type: "hydrateWorld",
        world: loaded.world,
      });
      this.updateStatus(`World "${worldId}" loaded. Scan marker to anchor.`);
    } catch (error) {
      if (requestVersion !== this.worldLoadVersion) {
        return;
      }

      this.worldStore.apply({
        type: "hydrateWorld",
        world: buildSeedWorld(),
      });

      const reason = error instanceof Error ? error.message : "backend unavailable";
      this.updateStatus(`Using seed fallback for "${worldId}" (${reason}).`);
    }
  }

  private connectMultiplayer(worldId: string): void {
    if (this.connectedWorldId === worldId) {
      return;
    }

    this.multiplayerClient.disconnect();
    this.connectedWorldId = worldId;
    this.localPlayerId = null;
    this.clearRemotePlayers();

    this.multiplayerClient.connect({
      userId: this.userId,
      worldId,
      callbacks: {
        onStatus: (status) => {
          if (status === "disconnected") {
            this.localPlayerId = null;
            this.clearRemotePlayers();
          }
        },
        onWelcome: (playerId) => {
          this.localPlayerId = playerId;
        },
        onSnapshot: (snapshot) => {
          this.applyMultiplayerSnapshot(snapshot);
        },
        onWorldCommit: (commit) => {
          this.applyMultiplayerWorldCommit(commit);
        },
        onError: (message) => {
          console.warn("AR multiplayer error", message);
        },
      },
    });
  }

  private applyMultiplayerSnapshot(snapshot: MultiplayerSnapshot): void {
    if (snapshot.world_id !== this.currentWorldId) {
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
    } catch (error) {
      console.warn("AR world sync failed", error);
    }
  }

  private upsertRemotePlayerMesh(remotePlayer: RemotePlayerState): void {
    const existingAvatar = this.remotePlayerAvatars.get(remotePlayer.player_id);
    const x = remotePlayer.position_3d[0] - this.parentCenter.x;
    const y = remotePlayer.position_3d[1] - this.parentCenter.y;
    const z = remotePlayer.position_3d[2] - this.parentCenter.z;

    if (existingAvatar) {
      existingAvatar.applyPose(x, y, z, remotePlayer.yaw, remotePlayer.pitch);
      return;
    }

    const avatar = createRemoteAvatarHandle();
    avatar.applyPose(x, y, z, remotePlayer.yaw, remotePlayer.pitch);
    this.worldContentGroup.add(avatar.object3d);
    this.remotePlayerAvatars.set(remotePlayer.player_id, avatar);
  }

  private removeRemotePlayerMesh(playerId: string): void {
    const avatar = this.remotePlayerAvatars.get(playerId);
    if (!avatar) {
      return;
    }

    this.worldContentGroup.remove(avatar.object3d);
    avatar.dispose();
    this.remotePlayerAvatars.delete(playerId);
  }

  private clearRemotePlayers(): void {
    for (const playerId of [...this.remotePlayerAvatars.keys()]) {
      this.removeRemotePlayerMesh(playerId);
    }
    this.remotePlayers.clear();
  }

  private readonly onWorldStoreChanged = (snapshot: WorldStoreSnapshot): void => {
    this.parentSphere = snapshot.parent;
    this.parentCenter.set(
      snapshot.parent.position3d[0],
      snapshot.parent.position3d[1],
      snapshot.parent.position3d[2],
    );

    if (this.parentMesh) {
      this.parentMesh.scale.setScalar(this.parentSphere.radius);
      this.parentMesh.visible = false;
    }

    this.refreshWorldRenderScale();

    this.syncObstaclesFromSnapshot(snapshot);
    for (const remotePlayer of this.remotePlayers.values()) {
      this.upsertRemotePlayerMesh(remotePlayer);
    }
  };

  private refreshWorldRenderScale(): void {
    const safeRadius = Math.max(this.parentSphere.radius, 0.001);
    const scaledRadius =
      WORLD_RENDER_RADIUS_METERS * this.currentWorldScaleMultiplier;
    this.worldGroup.scale.setScalar(scaledRadius / safeRadius);
  }

  private buildObstacleBody(
    entity: SphereEntity,
    portalHost: boolean,
    instancedSubworld: boolean,
  ): ArObstacle {
    return {
      id: entity.id,
      center: new THREE.Vector3(
        entity.position3d[0],
        entity.position3d[1],
        entity.position3d[2],
      ),
      radius: entity.radius,
      money: entity.dimensions.money ?? 0,
      portalHost,
      instancedSubworld,
    };
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
      const portalHost =
        entity.parentId === snapshot.parent.id &&
        Number.isFinite(templateId) &&
        Math.trunc(templateId) > TEMPLATE_NONE_ID;

      const existingBody = this.obstaclesById.get(entity.id);
      if (!existingBody) {
        const body = this.buildObstacleBody(entity, portalHost, instancedSubworld);
        this.obstaclesById.set(entity.id, body);
        this.addObstacleMesh(body);
        continue;
      }

      existingBody.center.set(entity.position3d[0], entity.position3d[1], entity.position3d[2]);
      existingBody.radius = entity.radius;
      existingBody.money = entity.dimensions.money ?? 0;
      existingBody.portalHost = portalHost;
      existingBody.instancedSubworld = instancedSubworld;

      const existingMesh = this.obstacleMeshes.get(entity.id);
      if (existingMesh) {
        existingMesh.position.set(
          existingBody.center.x - this.parentCenter.x,
          existingBody.center.y - this.parentCenter.y,
          existingBody.center.z - this.parentCenter.z,
        );
        existingMesh.scale.setScalar(existingBody.radius);
        existingMesh.userData.portalHost = existingBody.portalHost;
      }
    }

    for (const id of [...this.obstaclesById.keys()]) {
      if (nextIds.has(id)) {
        continue;
      }
      this.removeObstacleById(id);
    }

    this.recenterWorldContent();
    this.recolorObstacles();
  }

  private addObstacleMesh(obstacle: ArObstacle): void {
    const sphereGeometry = new THREE.SphereGeometry(1, 24, 18);
    const sphereMaterial = new THREE.MeshStandardMaterial({
      color: 0x7082a1,
      roughness: 0.75,
      metalness: 0.08,
    });
    const obstacleMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
    obstacleMesh.position.set(
      obstacle.center.x - this.parentCenter.x,
      obstacle.center.y - this.parentCenter.y,
      obstacle.center.z - this.parentCenter.z,
    );
    obstacleMesh.scale.setScalar(obstacle.radius);
    obstacleMesh.userData.sphereId = obstacle.id;
    obstacleMesh.userData.portalHost = obstacle.portalHost;
    this.worldContentGroup.add(obstacleMesh);
    this.obstacleMeshes.set(obstacle.id, obstacleMesh);
  }

  private removeObstacleById(obstacleId: string): void {
    this.obstaclesById.delete(obstacleId);

    const mesh = this.obstacleMeshes.get(obstacleId);
    if (mesh) {
      this.worldContentGroup.remove(mesh);
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
  }

  private recolorObstacles(): void {
    for (const obstacle of this.obstaclesById.values()) {
      const obstacleMesh = this.obstacleMeshes.get(obstacle.id);
      if (!obstacleMesh || !(obstacleMesh.material instanceof THREE.MeshStandardMaterial)) {
        continue;
      }

      if (obstacle.portalHost) {
        obstacleMesh.visible = false;
        continue;
      }

      obstacleMesh.visible = true;
      obstacleMesh.material.color.setHex(0x78849b);
      obstacleMesh.material.emissive.setHex(0x000000);
      obstacleMesh.material.transparent = false;
      obstacleMesh.material.opacity = 1;
      obstacleMesh.material.depthWrite = true;
      obstacleMesh.material.wireframe = false;
      obstacleMesh.material.roughness = 0.75;
      obstacleMesh.material.metalness = 0.08;
      obstacleMesh.material.needsUpdate = true;
    }
  }

  private clearObstacles(): void {
    for (const id of [...this.obstacleMeshes.keys()]) {
      this.removeObstacleById(id);
    }
    this.obstaclesById.clear();
  }

  private recenterWorldContent(): void {
    const visibleObstacles = [...this.obstaclesById.values()].filter(
      (obstacle) => !obstacle.portalHost,
    );
    if (visibleObstacles.length === 0) {
      this.autoCenterOffset.set(0, 0, 0);
      this.worldContentGroup.position.copy(this.autoCenterOffset);
      return;
    }

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (const obstacle of visibleObstacles) {
      const x = obstacle.center.x - this.parentCenter.x;
      const y = obstacle.center.y - this.parentCenter.y;
      const z = obstacle.center.z - this.parentCenter.z;
      const r = Math.max(0, obstacle.radius);

      minX = Math.min(minX, x - r);
      minY = Math.min(minY, y - r);
      minZ = Math.min(minZ, z - r);
      maxX = Math.max(maxX, x + r);
      maxY = Math.max(maxY, y + r);
      maxZ = Math.max(maxZ, z + r);
    }

    if (
      !Number.isFinite(minX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(minZ) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(maxY) ||
      !Number.isFinite(maxZ)
    ) {
      this.autoCenterOffset.set(0, 0, 0);
      this.worldContentGroup.position.copy(this.autoCenterOffset);
      return;
    }

    const centerX = (minX + maxX) * 0.5;
    const centerY = (minY + maxY) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    this.autoCenterOffset.set(-centerX, -centerY, -centerZ);
    this.worldContentGroup.position.copy(this.autoCenterOffset);
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

  private updateStatus(message: string): void {
    if (this.lastStatusMessage === message) {
      return;
    }
    this.lastStatusMessage = message;
    this.statusNode.textContent = message;
  }
}
