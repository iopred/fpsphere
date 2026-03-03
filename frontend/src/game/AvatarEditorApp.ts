import * as THREE from "three";
import {
  availableAvatarIds,
  avatarLabel,
  createRemoteAvatarHandle,
  defaultAvatarLayout,
  DEFAULT_AVATAR_ID,
  loadAvatarLayoutOverrides,
  saveAvatarLayoutOverrides,
  type AvatarId,
  type AvatarLayoutOverridesById,
  type AvatarRenderHandle,
  type DuckAvatarLayout,
  type HumanAvatarLayout,
} from "./avatarRenderAdapter";

interface SliderControlConfig {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (nextValue: number) => void;
}

export class AvatarEditorApp {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(52, 1, 0.1, 100);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly clock = new THREE.Clock();
  private readonly previewRoot = new THREE.Group();

  private readonly rootNode: HTMLDivElement;
  private readonly canvasNode: HTMLDivElement;
  private readonly panelNode: HTMLDivElement;
  private readonly avatarSelectNode: HTMLSelectElement;
  private readonly controlsNode: HTMLDivElement;
  private readonly statusNode: HTMLParagraphElement;

  private selectedAvatarId: AvatarId = DEFAULT_AVATAR_ID;
  private layoutOverrides: AvatarLayoutOverridesById = {};
  private currentAvatarHandle: AvatarRenderHandle | null = null;
  private disposed = false;

  constructor(private readonly mountNode: HTMLDivElement) {
    this.mountNode.innerHTML = "";

    this.rootNode = document.createElement("div");
    this.rootNode.className = "avatar-editor-root";
    this.mountNode.appendChild(this.rootNode);

    this.canvasNode = document.createElement("div");
    this.canvasNode.className = "avatar-editor-canvas";
    this.rootNode.appendChild(this.canvasNode);

    this.panelNode = document.createElement("div");
    this.panelNode.className = "avatar-editor-panel";
    this.rootNode.appendChild(this.panelNode);

    const titleNode = document.createElement("h1");
    titleNode.className = "avatar-editor-title";
    titleNode.textContent = "Avatar Editor";
    this.panelNode.appendChild(titleNode);

    const subtitleNode = document.createElement("p");
    subtitleNode.className = "avatar-editor-subtitle";
    subtitleNode.textContent =
      "Adjust avatar layout parameters, preview in real time, and save settings for FPS/AR rendering.";
    this.panelNode.appendChild(subtitleNode);

    const avatarRow = document.createElement("div");
    avatarRow.className = "avatar-editor-row";
    const avatarLabelNode = document.createElement("label");
    avatarLabelNode.className = "avatar-editor-label";
    avatarLabelNode.textContent = "Avatar";
    avatarRow.appendChild(avatarLabelNode);

    this.avatarSelectNode = document.createElement("select");
    this.avatarSelectNode.className = "avatar-editor-select";
    for (const avatarId of availableAvatarIds()) {
      const option = document.createElement("option");
      option.value = avatarId;
      option.textContent = avatarLabel(avatarId);
      this.avatarSelectNode.appendChild(option);
    }
    this.avatarSelectNode.value = this.selectedAvatarId;
    this.avatarSelectNode.addEventListener("change", () => {
      this.selectedAvatarId = this.avatarSelectNode.value as AvatarId;
      this.rebuildControls();
      this.refreshPreviewAvatar();
      this.updateStatus(`editing "${avatarLabel(this.selectedAvatarId)}"`);
    });
    avatarRow.appendChild(this.avatarSelectNode);
    this.panelNode.appendChild(avatarRow);

    this.controlsNode = document.createElement("div");
    this.controlsNode.className = "avatar-editor-controls";
    this.panelNode.appendChild(this.controlsNode);

    const actionsNode = document.createElement("div");
    actionsNode.className = "avatar-editor-actions";
    this.panelNode.appendChild(actionsNode);

    const resetButton = document.createElement("button");
    resetButton.type = "button";
    resetButton.className = "avatar-editor-button";
    resetButton.textContent = "Reset Current";
    resetButton.addEventListener("click", () => {
      if (this.selectedAvatarId === "human") {
        delete this.layoutOverrides.human;
      } else {
        delete this.layoutOverrides.duck;
      }
      this.persistOverrides();
      this.rebuildControls();
      this.refreshPreviewAvatar();
      this.updateStatus(`reset "${avatarLabel(this.selectedAvatarId)}"`);
    });
    actionsNode.appendChild(resetButton);

    const copyButton = document.createElement("button");
    copyButton.type = "button";
    copyButton.className = "avatar-editor-button";
    copyButton.textContent = "Copy JSON";
    copyButton.addEventListener("click", () => {
      const payload = JSON.stringify(this.layoutOverrides, null, 2);
      void this.copyToClipboard(payload);
    });
    actionsNode.appendChild(copyButton);

    const openGameLink = document.createElement("a");
    openGameLink.className = "avatar-editor-link";
    openGameLink.href = "/?mode=fps";
    openGameLink.textContent = "Open FPS mode";
    this.panelNode.appendChild(openGameLink);

    this.statusNode = document.createElement("p");
    this.statusNode.className = "avatar-editor-status";
    this.panelNode.appendChild(this.statusNode);

    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.canvasNode.appendChild(this.renderer.domElement);

    this.setupScene();
    this.layoutOverrides = loadAvatarLayoutOverrides();
    this.rebuildControls();
    this.refreshPreviewAvatar();
    this.updateStatus(`editing "${avatarLabel(this.selectedAvatarId)}"`);
  }

  start(): void {
    if (this.disposed) {
      return;
    }

    window.addEventListener("resize", this.onResize);
    this.onResize();
    this.renderer.setAnimationLoop(this.animate);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    window.removeEventListener("resize", this.onResize);
    this.renderer.setAnimationLoop(null);
    this.disposePreviewAvatar();
    this.renderer.dispose();
  }

  private setupScene(): void {
    this.scene.background = new THREE.Color(0x0a1020);

    this.camera.position.set(0, 1.55, 3.6);
    this.camera.lookAt(0, 0.95, 0);

    const ambientLight = new THREE.AmbientLight(0xd2defd, 0.35);
    this.scene.add(ambientLight);

    const keyLight = new THREE.DirectionalLight(0xc2deff, 1.1);
    keyLight.position.set(3.5, 5, 3.5);
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0x7da4f0, 0.45);
    fillLight.position.set(-2.8, 2.4, -2.5);
    this.scene.add(fillLight);

    const groundGrid = new THREE.GridHelper(8, 20, 0x5f89d6, 0x26354f);
    groundGrid.position.y = -0.01;
    this.scene.add(groundGrid);

    this.scene.add(this.previewRoot);
  }

  private rebuildControls(): void {
    this.controlsNode.textContent = "";

    if (this.selectedAvatarId === "human") {
      const defaults = defaultAvatarLayout("human") as HumanAvatarLayout;
      const overrides = this.layoutOverrides.human ?? {};
      const resolved: HumanAvatarLayout = {
        ...defaults,
        ...overrides,
      };

      this.appendSliderControl({
        label: "Torso Y",
        min: 0.1,
        max: 0.8,
        step: 0.01,
        value: resolved.torsoYOffset,
        onChange: (nextValue) => this.updateHumanLayoutValue("torsoYOffset", nextValue),
      });
      this.appendSliderControl({
        label: "Head Y",
        min: 0.7,
        max: 1.6,
        step: 0.01,
        value: resolved.headYOffset,
        onChange: (nextValue) => this.updateHumanLayoutValue("headYOffset", nextValue),
      });
      this.appendSliderControl({
        label: "Arm Y",
        min: 0.1,
        max: 0.9,
        step: 0.01,
        value: resolved.armYOffset,
        onChange: (nextValue) => this.updateHumanLayoutValue("armYOffset", nextValue),
      });
      this.appendSliderControl({
        label: "Dir Y",
        min: 0.1,
        max: 1.1,
        step: 0.01,
        value: resolved.directionYOffset,
        onChange: (nextValue) => this.updateHumanLayoutValue("directionYOffset", nextValue),
      });
      this.appendSliderControl({
        label: "Dir Z",
        min: -1.2,
        max: 0.1,
        step: 0.01,
        value: resolved.directionZOffset,
        onChange: (nextValue) => this.updateHumanLayoutValue("directionZOffset", nextValue),
      });
      return;
    }

    const defaults = defaultAvatarLayout("duck") as DuckAvatarLayout;
    const overrides = this.layoutOverrides.duck ?? {};
    const resolved: DuckAvatarLayout = {
      ...defaults,
      ...overrides,
    };

    this.appendSliderControl({
      label: "Head Y",
      min: 0.55,
      max: 1.3,
      step: 0.01,
      value: resolved.headYOffset,
      onChange: (nextValue) => this.updateDuckLayoutValue("headYOffset", nextValue),
    });
    this.appendSliderControl({
      label: "Head Z",
      min: -0.3,
      max: 0.35,
      step: 0.01,
      value: resolved.headZOffset,
      onChange: (nextValue) => this.updateDuckLayoutValue("headZOffset", nextValue),
    });
    this.appendSliderControl({
      label: "Beak Y",
      min: 0.35,
      max: 1.2,
      step: 0.01,
      value: resolved.beakYOffset,
      onChange: (nextValue) => this.updateDuckLayoutValue("beakYOffset", nextValue),
    });
    this.appendSliderControl({
      label: "Beak Z",
      min: -1.2,
      max: -0.05,
      step: 0.01,
      value: resolved.beakZOffset,
      onChange: (nextValue) => this.updateDuckLayoutValue("beakZOffset", nextValue),
    });
    this.appendSliderControl({
      label: "Beak Rot X",
      min: -Math.PI,
      max: Math.PI,
      step: 0.01,
      value: resolved.beakRotationX,
      onChange: (nextValue) => this.updateDuckLayoutValue("beakRotationX", nextValue),
    });
  }

  private appendSliderControl(config: SliderControlConfig): void {
    const row = document.createElement("div");
    row.className = "avatar-editor-slider-row";

    const labelNode = document.createElement("label");
    labelNode.className = "avatar-editor-slider-label";
    labelNode.textContent = config.label;
    row.appendChild(labelNode);

    const inputNode = document.createElement("input");
    inputNode.className = "avatar-editor-slider";
    inputNode.type = "range";
    inputNode.min = String(config.min);
    inputNode.max = String(config.max);
    inputNode.step = String(config.step);
    inputNode.value = String(config.value);
    row.appendChild(inputNode);

    const valueNode = document.createElement("span");
    valueNode.className = "avatar-editor-slider-value";
    valueNode.textContent = Number(config.value).toFixed(2);
    row.appendChild(valueNode);

    inputNode.addEventListener("input", () => {
      const parsed = Number(inputNode.value);
      if (!Number.isFinite(parsed)) {
        return;
      }
      valueNode.textContent = parsed.toFixed(2);
      config.onChange(parsed);
    });

    this.controlsNode.appendChild(row);
  }

  private updateDuckLayoutValue(key: keyof DuckAvatarLayout, value: number): void {
    this.layoutOverrides.duck = {
      ...(this.layoutOverrides.duck ?? {}),
      [key]: value,
    };
    this.persistOverrides();
    this.refreshPreviewAvatar();
  }

  private updateHumanLayoutValue(key: keyof HumanAvatarLayout, value: number): void {
    this.layoutOverrides.human = {
      ...(this.layoutOverrides.human ?? {}),
      [key]: value,
    };
    this.persistOverrides();
    this.refreshPreviewAvatar();
  }

  private persistOverrides(): void {
    saveAvatarLayoutOverrides(this.layoutOverrides);
  }

  private refreshPreviewAvatar(): void {
    this.disposePreviewAvatar();

    const layoutOverride =
      this.selectedAvatarId === "human"
        ? this.layoutOverrides.human
        : this.layoutOverrides.duck;

    this.currentAvatarHandle = createRemoteAvatarHandle({
      avatarId: this.selectedAvatarId,
      playerId: "preview-player",
      layoutOverrides: layoutOverride,
    });
    this.currentAvatarHandle.applyPose(0, 0.85, 0, 0, 0);
    this.previewRoot.add(this.currentAvatarHandle.object3d);
  }

  private disposePreviewAvatar(): void {
    if (!this.currentAvatarHandle) {
      return;
    }

    this.previewRoot.remove(this.currentAvatarHandle.object3d);
    this.currentAvatarHandle.dispose();
    this.currentAvatarHandle = null;
  }

  private copyToClipboard(payload: string): Promise<void> {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      this.updateStatus("clipboard unavailable; open devtools to copy manually");
      return Promise.resolve();
    }

    return navigator.clipboard
      .writeText(payload)
      .then(() => {
        this.updateStatus("layout JSON copied to clipboard");
      })
      .catch(() => {
        this.updateStatus("copy failed");
      });
  }

  private updateStatus(message: string): void {
    this.statusNode.textContent = message;
  }

  private readonly onResize = (): void => {
    const width = Math.max(this.canvasNode.clientWidth, 1);
    const height = Math.max(this.canvasNode.clientHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private readonly animate = (): void => {
    const dt = Math.min(this.clock.getDelta(), 0.05);
    this.previewRoot.rotation.y += dt * 0.55;
    this.renderer.render(this.scene, this.camera);
  };
}
