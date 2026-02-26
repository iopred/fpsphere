import type { SphereEntity } from "@fpsphere/shared-types";
import type { SeedWorld } from "./worldSeed";

export type WorldEditCommand =
  | {
      type: "hydrateWorld";
      world: SeedWorld;
    }
  | {
      type: "createSphere";
      sphere: SphereEntity;
      selectCreated?: boolean;
    }
  | {
      type: "selectSphere";
      sphereId: string;
    }
  | {
      type: "deselectSphere";
    }
  | {
      type: "deleteSphere";
      sphereId: string;
    }
  | {
      type: "updateSphereDimensions";
      sphereId: string;
      dimensions: Record<string, number>;
    }
  | {
      type: "updateSpherePosition";
      sphereId: string;
      position3d: [number, number, number];
    }
  | {
      type: "updateSphereRadius";
      sphereId: string;
      radius: number;
    }
  | {
      type: "enterSphere";
      sphereId: string;
    }
  | {
      type: "exitSphere";
    };

export interface WorldStoreSnapshot {
  parent: SphereEntity;
  children: SphereEntity[];
  selectedSphereId: string | null;
  version: number;
}

type WorldStoreListener = (snapshot: WorldStoreSnapshot, command: WorldEditCommand) => void;

function cloneSphere(entity: SphereEntity): SphereEntity {
  return {
    id: entity.id,
    parentId: entity.parentId,
    radius: entity.radius,
    position3d: [...entity.position3d],
    dimensions: { ...entity.dimensions },
    timeWindow: { ...entity.timeWindow },
    tags: [...entity.tags],
  };
}

export class LocalWorldStore {
  private readonly entitiesById = new Map<string, SphereEntity>();
  private readonly listeners = new Set<WorldStoreListener>();

  private rootSphereId: string;
  private activeParentId: string;
  private selectedSphereId: string | null = null;
  private version = 0;

  constructor(seedWorld: SeedWorld) {
    const parent = cloneSphere(seedWorld.parent);
    this.rootSphereId = parent.id;
    this.activeParentId = parent.id;
    this.entitiesById.set(parent.id, parent);

    for (const child of seedWorld.children) {
      this.entitiesById.set(child.id, cloneSphere(child));
    }
  }

  private getActiveParent(): SphereEntity | null {
    return this.entitiesById.get(this.activeParentId) ?? null;
  }

  getParentSphere(): SphereEntity {
    const activeParent = this.getActiveParent();
    if (activeParent) {
      return activeParent;
    }

    const root = this.entitiesById.get(this.rootSphereId);
    if (!root) {
      throw new Error("World store is missing root sphere");
    }

    return root;
  }

  getRootSphere(): SphereEntity {
    const root = this.entitiesById.get(this.rootSphereId);
    if (!root) {
      throw new Error("World store is missing root sphere");
    }

    return root;
  }

  getSelectedSphereId(): string | null {
    return this.selectedSphereId;
  }

  getSphereById(sphereId: string): SphereEntity | null {
    return this.entitiesById.get(sphereId) ?? null;
  }

  getChildSphereById(sphereId: string): SphereEntity | null {
    return this.getSphereById(sphereId);
  }

  listChildSpheres(): SphereEntity[] {
    const activeParentId = this.activeParentId;
    return [...this.entitiesById.values()].filter((entity) => entity.parentId === activeParentId);
  }

  listChildrenOf(parentId: string): SphereEntity[] {
    return [...this.entitiesById.values()].filter((entity) => entity.parentId === parentId);
  }

  listDescendantsOf(parentId: string): SphereEntity[] {
    const descendants: SphereEntity[] = [];
    const queue: string[] = [parentId];

    while (queue.length > 0) {
      const currentParentId = queue.shift();
      if (!currentParentId) {
        continue;
      }

      const children = this.listChildrenOf(currentParentId);
      for (const child of children) {
        descendants.push(child);
        queue.push(child.id);
      }
    }

    return descendants;
  }

  getSnapshot(): WorldStoreSnapshot {
    return {
      parent: this.getParentSphere(),
      children: this.listChildSpheres(),
      selectedSphereId: this.selectedSphereId,
      version: this.version,
    };
  }

  subscribe(listener: WorldStoreListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  apply(command: WorldEditCommand): boolean {
    let changed = false;

    switch (command.type) {
      case "hydrateWorld": {
        const { world } = command;
        const previousActiveParentId = this.activeParentId;
        const previousSelectedSphereId = this.selectedSphereId;

        this.entitiesById.clear();
        const rootSphere = cloneSphere(world.parent);
        this.entitiesById.set(rootSphere.id, rootSphere);
        for (const child of world.children) {
          this.entitiesById.set(child.id, cloneSphere(child));
        }

        this.rootSphereId = rootSphere.id;
        this.activeParentId = this.entitiesById.has(previousActiveParentId)
          ? previousActiveParentId
          : rootSphere.id;

        this.selectedSphereId = previousSelectedSphereId;
        if (
          this.selectedSphereId &&
          !this.entitiesById.has(this.selectedSphereId)
        ) {
          this.selectedSphereId = null;
        }

        if (this.selectedSphereId) {
          const selected = this.entitiesById.get(this.selectedSphereId);
          if (!selected || selected.parentId !== this.activeParentId) {
            this.selectedSphereId = null;
          }
        }

        changed = true;
        break;
      }

      case "createSphere": {
        const { sphere } = command;
        if (this.entitiesById.has(sphere.id)) {
          return false;
        }

        const parentId = sphere.parentId ?? this.activeParentId;
        if (!this.entitiesById.has(parentId)) {
          return false;
        }

        this.entitiesById.set(sphere.id, {
          ...cloneSphere(sphere),
          parentId,
        });

        if (command.selectCreated === true) {
          this.selectedSphereId = sphere.id;
        }

        changed = true;
        break;
      }

      case "selectSphere": {
        const sphere = this.entitiesById.get(command.sphereId);
        if (!sphere || sphere.parentId !== this.activeParentId) {
          return false;
        }

        if (this.selectedSphereId === command.sphereId) {
          return false;
        }

        this.selectedSphereId = command.sphereId;
        changed = true;
        break;
      }

      case "deselectSphere": {
        if (this.selectedSphereId === null) {
          return false;
        }

        this.selectedSphereId = null;
        changed = true;
        break;
      }

      case "deleteSphere": {
        const sphere = this.entitiesById.get(command.sphereId);
        if (!sphere || sphere.parentId !== this.activeParentId) {
          return false;
        }

        const hasChildren = [...this.entitiesById.values()].some(
          (item) => item.parentId === command.sphereId,
        );
        if (hasChildren) {
          return false;
        }

        this.entitiesById.delete(command.sphereId);
        if (this.selectedSphereId === command.sphereId) {
          this.selectedSphereId = null;
        }
        changed = true;
        break;
      }

      case "updateSphereDimensions": {
        const sphere = this.entitiesById.get(command.sphereId);
        if (!sphere) {
          return false;
        }

        const nextDimensions = { ...sphere.dimensions };
        let dimensionsChanged = false;
        for (const [key, value] of Object.entries(command.dimensions)) {
          if (!Number.isFinite(value)) {
            continue;
          }

          if (nextDimensions[key] !== value) {
            nextDimensions[key] = value;
            dimensionsChanged = true;
          }
        }

        if (!dimensionsChanged) {
          return false;
        }

        sphere.dimensions = nextDimensions;
        changed = true;
        break;
      }

      case "updateSpherePosition": {
        const sphere = this.entitiesById.get(command.sphereId);
        if (!sphere) {
          return false;
        }

        const next = command.position3d;
        const positionChanged =
          sphere.position3d[0] !== next[0] ||
          sphere.position3d[1] !== next[1] ||
          sphere.position3d[2] !== next[2];
        if (!positionChanged) {
          return false;
        }

        const previousPosition: [number, number, number] = [...sphere.position3d];
        sphere.position3d = [...next];

        const deltaX = next[0] - previousPosition[0];
        const deltaY = next[1] - previousPosition[1];
        const deltaZ = next[2] - previousPosition[2];

        if (
          Math.abs(deltaX) > 1e-6 ||
          Math.abs(deltaY) > 1e-6 ||
          Math.abs(deltaZ) > 1e-6
        ) {
          for (const descendant of this.listDescendantsOf(sphere.id)) {
            descendant.position3d = [
              descendant.position3d[0] + deltaX,
              descendant.position3d[1] + deltaY,
              descendant.position3d[2] + deltaZ,
            ];
          }
        }

        changed = true;
        break;
      }

      case "updateSphereRadius": {
        const sphere = this.entitiesById.get(command.sphereId);
        if (!sphere) {
          return false;
        }

        if (!Number.isFinite(command.radius) || command.radius <= 0) {
          return false;
        }

        if (sphere.radius === command.radius) {
          return false;
        }

        const previousRadius = sphere.radius;
        sphere.radius = command.radius;

        const scale = command.radius / previousRadius;
        if (Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > 1e-6) {
          const centerX = sphere.position3d[0];
          const centerY = sphere.position3d[1];
          const centerZ = sphere.position3d[2];

          for (const descendant of this.listDescendantsOf(sphere.id)) {
            const offsetX = descendant.position3d[0] - centerX;
            const offsetY = descendant.position3d[1] - centerY;
            const offsetZ = descendant.position3d[2] - centerZ;

            descendant.position3d = [
              centerX + offsetX * scale,
              centerY + offsetY * scale,
              centerZ + offsetZ * scale,
            ];
            descendant.radius = Math.max(0.01, descendant.radius * scale);
          }
        }

        changed = true;
        break;
      }

      case "enterSphere": {
        const sphere = this.entitiesById.get(command.sphereId);
        if (!sphere || sphere.parentId === null) {
          return false;
        }

        this.activeParentId = sphere.id;
        this.selectedSphereId = null;
        changed = true;
        break;
      }

      case "exitSphere": {
        const activeParent = this.getActiveParent();
        if (!activeParent || activeParent.parentId === null) {
          return false;
        }

        this.activeParentId = activeParent.parentId;
        this.selectedSphereId = null;
        changed = true;
        break;
      }

      default:
        return false;
    }

    if (!changed) {
      return false;
    }

    this.version += 1;
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot, command);
    }

    return true;
  }
}
