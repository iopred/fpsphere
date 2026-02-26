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
    };

export interface WorldStoreSnapshot {
  parent: SphereEntity;
  children: SphereEntity[];
  selectedSphereId: string | null;
  version: number;
}

type WorldStoreListener = (snapshot: WorldStoreSnapshot, command: WorldEditCommand) => void;

export class LocalWorldStore {
  private readonly parent: SphereEntity;
  private readonly childrenById = new Map<string, SphereEntity>();
  private readonly listeners = new Set<WorldStoreListener>();

  private selectedSphereId: string | null = null;
  private version = 0;

  constructor(seedWorld: SeedWorld) {
    this.parent = seedWorld.parent;

    for (const child of seedWorld.children) {
      if (child.parentId !== this.parent.id) {
        continue;
      }
      this.childrenById.set(child.id, child);
    }
  }

  getParentSphere(): SphereEntity {
    return this.parent;
  }

  getSelectedSphereId(): string | null {
    return this.selectedSphereId;
  }

  getChildSphereById(sphereId: string): SphereEntity | null {
    return this.childrenById.get(sphereId) ?? null;
  }

  listChildSpheres(): SphereEntity[] {
    return [...this.childrenById.values()];
  }

  getSnapshot(): WorldStoreSnapshot {
    return {
      parent: this.parent,
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

        if (world.parent.id !== this.parent.id) {
          return false;
        }

        this.parent.radius = world.parent.radius;
        this.parent.position3d = [...world.parent.position3d];
        this.parent.dimensions = { ...world.parent.dimensions };
        this.parent.timeWindow = { ...world.parent.timeWindow };
        this.parent.tags = [...world.parent.tags];

        this.childrenById.clear();
        for (const child of world.children) {
          if (child.parentId !== this.parent.id) {
            continue;
          }

          this.childrenById.set(child.id, {
            ...child,
            parentId: this.parent.id,
          });
        }

        if (
          this.selectedSphereId !== null &&
          !this.childrenById.has(this.selectedSphereId)
        ) {
          this.selectedSphereId = null;
        }

        changed = true;
        break;
      }

      case "createSphere": {
        const { sphere } = command;
        if (this.childrenById.has(sphere.id)) {
          return false;
        }

        const parentId = sphere.parentId ?? this.parent.id;
        if (parentId !== this.parent.id) {
          return false;
        }

        this.childrenById.set(sphere.id, {
          ...sphere,
          parentId: this.parent.id,
        });

        if (command.selectCreated === true) {
          this.selectedSphereId = sphere.id;
        }

        changed = true;
        break;
      }

      case "selectSphere": {
        if (!this.childrenById.has(command.sphereId)) {
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
        if (!this.childrenById.has(command.sphereId)) {
          return false;
        }

        this.childrenById.delete(command.sphereId);
        if (this.selectedSphereId === command.sphereId) {
          this.selectedSphereId = null;
        }
        changed = true;
        break;
      }

      case "updateSphereDimensions": {
        const sphere = this.childrenById.get(command.sphereId);
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
        const sphere = this.childrenById.get(command.sphereId);
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

        sphere.position3d = [...next];
        changed = true;
        break;
      }

      case "updateSphereRadius": {
        const sphere = this.childrenById.get(command.sphereId);
        if (!sphere) {
          return false;
        }

        if (!Number.isFinite(command.radius) || command.radius <= 0) {
          return false;
        }

        if (sphere.radius === command.radius) {
          return false;
        }

        sphere.radius = command.radius;
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
