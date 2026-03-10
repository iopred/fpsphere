import * as THREE from "three";
import type { SphereEntity } from "@fpsphere/shared-types";

export interface EditorActionsConfig {
  createdSphereRadius: number;
  minEditRadius: number;
  playerRadius: number;
  createDistance: number;
  createBoundaryMargin: number;
}

export interface EditorActionsCallbacks {
  getUserId: () => string;
  getExistingSphereById: (sphereId: string) => SphereEntity | null;
  getParentSphere: () => SphereEntity;
  getParentCenter: () => THREE.Vector3;
  getPlayerPosition: () => THREE.Vector3;
  getCamera: () => THREE.Camera;
  getCreateInstanceWorldId: () => string | null;
  getTick: () => number;
  getDefaultColorDimensions: () => Record<string, number>;
  randomMoney: () => number;
  createSphere: (sphere: SphereEntity, selectCreated: boolean) => boolean;
  onSphereCreated: (sphere: SphereEntity) => void;
  listObstacleMeshes: () => THREE.Mesh[];
  deselectSphere: () => void;
  selectSphere: (sphereId: string) => void;
  getSelectedSphereId: () => string | null;
  getDraggingSphereId: () => string | null;
  stopDraggingSphere: () => void;
  deleteSphere: (sphereId: string) => boolean;
  onSphereDeleted: (sphereId: string) => void;
}

export interface CreateSphereOptions {
  selectCreated?: boolean;
}

export class EditorActionsController {
  private readonly config: EditorActionsConfig;
  private readonly callbacks: EditorActionsCallbacks;

  private createdSphereCount = 0;
  private readonly raycaster = new THREE.Raycaster();
  private readonly tempForward = new THREE.Vector3();
  private readonly tempOffset = new THREE.Vector3();
  private readonly tempRaycastPoint = new THREE.Vector2(0, 0);

  constructor(config: EditorActionsConfig, callbacks: EditorActionsCallbacks) {
    this.config = config;
    this.callbacks = callbacks;
  }

  createSphereInFrontOfPlayer(options: CreateSphereOptions = {}): void {
    const selectCreated = options.selectCreated ?? true;
    const id = this.nextCreatedSphereId();
    this.callbacks.getCamera().getWorldDirection(this.tempForward);

    const parentSphere = this.callbacks.getParentSphere();
    const parentCenter = this.callbacks.getParentCenter();

    const createdSphereRadius = Number(
      Math.min(
        this.config.createdSphereRadius,
        Math.max(this.config.minEditRadius * 2, parentSphere.radius * 0.12),
      ).toFixed(3),
    );
    const minimumCreateDistance = this.config.playerRadius + createdSphereRadius + 0.8;
    const createDistance = Math.min(
      this.config.createDistance,
      Math.max(minimumCreateDistance, parentSphere.radius * 0.42),
    );

    const center = this.callbacks
      .getPlayerPosition()
      .clone()
      .addScaledVector(this.tempForward.normalize(), createDistance);

    this.tempOffset.copy(center).sub(parentCenter);
    const distanceFromCenter = this.tempOffset.length();
    const maxDistance = parentSphere.radius - createdSphereRadius - this.config.createBoundaryMargin;
    if (distanceFromCenter > maxDistance) {
      if (distanceFromCenter > 1e-6) {
        center.copy(parentCenter).addScaledVector(this.tempOffset.normalize(), maxDistance);
      } else {
        center.copy(parentCenter).add(new THREE.Vector3(0, 0, maxDistance));
      }
    }

    const createInstanceWorldId = this.callbacks.getCreateInstanceWorldId()?.trim() || null;
    const dimensions: Record<string, number> = {
      money: this.callbacks.randomMoney(),
      ...this.callbacks.getDefaultColorDimensions(),
    };

    const tags = ["user-created"];
    if (createInstanceWorldId) {
      tags.push("world-instance");
    }

    const sphere: SphereEntity = {
      id,
      parentId: parentSphere.id,
      radius: createdSphereRadius,
      position3d: [center.x, center.y, center.z],
      dimensions,
      instanceWorldId: createInstanceWorldId,
      timeWindow: {
        start: this.callbacks.getTick(),
        end: null,
      },
      tags,
    };

    const changed = this.callbacks.createSphere(sphere, selectCreated);
    if (changed) {
      this.callbacks.onSphereCreated(sphere);
    }
  }

  selectSphereAtReticle(): void {
    const meshes = this.callbacks.listObstacleMeshes();
    if (meshes.length === 0) {
      this.callbacks.deselectSphere();
      return;
    }

    this.raycaster.setFromCamera(this.tempRaycastPoint, this.callbacks.getCamera());
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
      this.callbacks.selectSphere(selectedId);
    }
  }

  deleteSelectedSphere(): void {
    const selectedId = this.callbacks.getSelectedSphereId();
    if (!selectedId) {
      return;
    }

    if (this.callbacks.getDraggingSphereId() === selectedId) {
      this.callbacks.stopDraggingSphere();
    }

    const changed = this.callbacks.deleteSphere(selectedId);
    if (changed) {
      this.callbacks.onSphereDeleted(selectedId);
    }
  }

  private nextCreatedSphereId(): string {
    const userPrefix = this.callbacks
      .getUserId()
      .replace(/[^a-zA-Z0-9-]/g, "")
      .slice(0, 12) || "local";

    for (let attempt = 0; attempt < 256; attempt += 1) {
      this.createdSphereCount += 1;
      const id = `sphere-user-${userPrefix}-${String(this.createdSphereCount).padStart(4, "0")}`;
      if (!this.callbacks.getExistingSphereById(id)) {
        return id;
      }
    }

    return `sphere-user-${userPrefix}-${Date.now().toString(36)}`;
  }
}
