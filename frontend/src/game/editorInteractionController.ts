import * as THREE from "three";
import type { SphereEntity } from "@fpsphere/shared-types";

interface EditorOrientation {
  yaw: number;
  pitch: number;
}

export interface EditorInteractionConfig {
  minEditRadius: number;
  mouseWheelRadiusStep: number;
  dragMinDistance: number;
  createBoundaryMargin: number;
  playerRadius: number;
  createDistance: number;
}

export interface EditorInteractionCallbacks {
  isEditorMode: () => boolean;
  isPointerLocked: () => boolean;
  isEditorHudTarget: (target: EventTarget | null) => boolean;
  getSelectedSphereId: () => string | null;
  getSelectedEditableSphere: () => SphereEntity | null;
  selectSphereAtReticle: () => void;
  getPlayerPosition: () => THREE.Vector3;
  getParentCenter: () => THREE.Vector3;
  getParentRadius: () => number;
  updateSphereRadius: (sphereId: string, radius: number) => boolean;
  onSphereRadiusChanged: (sphereId: string, radius: number) => void;
  updateSpherePosition: (sphereId: string, position3d: [number, number, number]) => boolean;
  onSpherePositionChanged: (
    sphereId: string,
    position3d: [number, number, number],
  ) => void;
}

export interface EditorInteractionOptions {
  config: EditorInteractionConfig;
  callbacks: EditorInteractionCallbacks;
}

export class EditorInteractionController {
  private readonly config: EditorInteractionConfig;
  private readonly callbacks: EditorInteractionCallbacks;

  private draggingSphereId: string | null = null;
  private dragDistance: number;

  private readonly tempForward = new THREE.Vector3();
  private readonly tempOffset = new THREE.Vector3();
  private readonly tempDragTarget = new THREE.Vector3();
  private readonly tempLookEuler = new THREE.Euler(0, 0, 0, "YXZ");

  constructor(options: EditorInteractionOptions) {
    this.config = options.config;
    this.callbacks = options.callbacks;
    this.dragDistance = this.config.createDistance;
  }

  get currentDraggingSphereId(): string | null {
    return this.draggingSphereId;
  }

  stopDraggingSphere(): void {
    this.draggingSphereId = null;
  }

  handleWheel(event: WheelEvent): void {
    if (!this.callbacks.isEditorMode()) {
      return;
    }

    if (this.callbacks.isEditorHudTarget(event.target)) {
      return;
    }

    const selectedSphere = this.callbacks.getSelectedEditableSphere();
    if (!selectedSphere) {
      return;
    }

    const direction = event.deltaY < 0 ? 1 : -1;

    event.preventDefault();
    const maxRadius = Math.max(
      this.config.minEditRadius,
      this.callbacks.getParentRadius() - this.config.createBoundaryMargin - this.config.playerRadius,
    );
    const nextRadius = Math.max(
      this.config.minEditRadius,
      Math.min(maxRadius, selectedSphere.radius + direction * this.config.mouseWheelRadiusStep),
    );
    const roundedRadius = Number(nextRadius.toFixed(3));
    if (roundedRadius === selectedSphere.radius) {
      return;
    }

    const changed = this.callbacks.updateSphereRadius(selectedSphere.id, roundedRadius);
    if (!changed) {
      return;
    }

    this.callbacks.onSphereRadiusChanged(selectedSphere.id, roundedRadius);
  }

  handleMouseDown(event: MouseEvent): void {
    if (!this.callbacks.isEditorMode() || event.button !== 2) {
      return;
    }

    if (!this.callbacks.isPointerLocked()) {
      return;
    }

    if (this.callbacks.isEditorHudTarget(event.target)) {
      return;
    }

    if (!this.callbacks.getSelectedSphereId()) {
      this.callbacks.selectSphereAtReticle();
    }

    const selectedSphere = this.callbacks.getSelectedEditableSphere();
    if (!selectedSphere) {
      this.stopDraggingSphere();
      return;
    }

    event.preventDefault();
    this.draggingSphereId = selectedSphere.id;
    this.tempOffset
      .set(
        selectedSphere.position3d[0],
        selectedSphere.position3d[1],
        selectedSphere.position3d[2],
      )
      .sub(this.callbacks.getPlayerPosition());
    const maxDistance = Math.max(
      this.config.dragMinDistance,
      this.callbacks.getParentRadius() - selectedSphere.radius - this.config.createBoundaryMargin,
    );
    this.dragDistance = Math.max(
      this.config.dragMinDistance,
      Math.min(maxDistance, this.tempOffset.length()),
    );
  }

  handleMouseUp(event: MouseEvent): void {
    if (event.button !== 2) {
      return;
    }

    this.stopDraggingSphere();
  }

  handleContextMenu(event: MouseEvent): void {
    if (this.callbacks.isEditorMode() && this.callbacks.isPointerLocked()) {
      event.preventDefault();
    }
  }

  handleWindowBlur(): void {
    this.stopDraggingSphere();
  }

  updateDraggedSphere(orientation: EditorOrientation): void {
    if (!this.callbacks.isEditorMode() || !this.draggingSphereId) {
      return;
    }

    const sphereId = this.draggingSphereId;
    const selectedSphereId = this.callbacks.getSelectedSphereId();
    if (selectedSphereId !== sphereId) {
      this.stopDraggingSphere();
      return;
    }

    const sphere = this.callbacks.getSelectedEditableSphere();
    if (!sphere || sphere.id !== sphereId) {
      this.stopDraggingSphere();
      return;
    }

    this.tempLookEuler.set(orientation.pitch, orientation.yaw, 0, "YXZ");
    this.tempForward.set(0, 0, -1).applyEuler(this.tempLookEuler).normalize();
    this.tempDragTarget
      .copy(this.callbacks.getPlayerPosition())
      .addScaledVector(this.tempForward, this.dragDistance);

    const parentCenter = this.callbacks.getParentCenter();
    this.tempOffset.copy(this.tempDragTarget).sub(parentCenter);
    const distanceFromCenter = this.tempOffset.length();
    const maxDistance = Math.max(
      this.config.dragMinDistance,
      this.callbacks.getParentRadius() - sphere.radius - this.config.createBoundaryMargin,
    );
    if (distanceFromCenter > maxDistance) {
      if (distanceFromCenter > 1e-6) {
        this.tempDragTarget
          .copy(parentCenter)
          .addScaledVector(this.tempOffset.normalize(), maxDistance);
      } else {
        this.tempDragTarget.set(parentCenter.x, parentCenter.y, parentCenter.z + maxDistance);
      }
    }

    const nextPosition: [number, number, number] = [
      Number(this.tempDragTarget.x.toFixed(3)),
      Number(this.tempDragTarget.y.toFixed(3)),
      Number(this.tempDragTarget.z.toFixed(3)),
    ];

    const changed = this.callbacks.updateSpherePosition(sphereId, nextPosition);
    if (!changed) {
      return;
    }

    this.callbacks.onSpherePositionChanged(sphereId, nextPosition);
  }
}
