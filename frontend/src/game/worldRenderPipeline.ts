import * as THREE from "three";
import type { SphereEntity } from "@fpsphere/shared-types";
import type { SeedWorld } from "./worldSeed";
import type { WorldStoreSnapshot } from "./worldStore";
import {
  getTemplateRootSphereId,
  instantiateSubworldChildren,
  SUBWORLD_PITCH_DIMENSION,
  SUBWORLD_SCALE_DIMENSION,
  SUBWORLD_TEMPLATE_DIMENSION,
  SUBWORLD_YAW_DIMENSION,
  TEMPLATE_DEFINITION_TAG,
  TEMPLATE_ROOT_TAG,
} from "./subworldTemplates";
import {
  normalizeInstanceWorldIdForRuntime,
  resolveTemplateIdFromEntity,
} from "./worldInstanceRefs";
import {
  tintWorldInstanceChildDimensions,
  type SphereColorChannels,
  type SphereColorDimensionKeys,
} from "./worldInstanceTint";

const TEMPLATE_NONE_ID = 0;
const MIN_ENTITY_RADIUS = 0.05;
export const DEFAULT_WORLD_INSTANCE_RENDER_DEPTH = 2;
const templateRotationOffset = new THREE.Vector3();
const templateRotationEuler = new THREE.Euler(0, 0, 0, "YXZ");

interface SharedTemplateExpansionParams {
  hostSpheres: SphereEntity[];
  listChildrenOf: (parentId: string) => SphereEntity[];
  getSphereById: (sphereId: string) => SphereEntity | null;
}

interface ReferencedWorldExpansionParams {
  hostSpheres: SphereEntity[];
  currentWorldId: string | null;
  instancedWorldById: ReadonlyMap<string, SeedWorld>;
  ensureInstancedWorldLoaded: (worldId: string) => void;
  worldInstanceRenderDepth: number;
  colorConfig: {
    defaultColorChannels: SphereColorChannels;
    colorDimensionKeys: SphereColorDimensionKeys;
  };
}

export interface ExpandWorldRenderEntitiesParams {
  snapshot: WorldStoreSnapshot;
  currentWorldId: string | null;
  listChildrenOf: (parentId: string) => SphereEntity[];
  listDescendantsOf: (parentId: string) => SphereEntity[];
  getSphereById: (sphereId: string) => SphereEntity | null;
  instancedWorldById: ReadonlyMap<string, SeedWorld>;
  ensureInstancedWorldLoaded: (worldId: string) => void;
  worldInstanceRenderDepth: number;
  colorConfig: {
    defaultColorChannels: SphereColorChannels;
    colorDimensionKeys: SphereColorDimensionKeys;
  };
}

export interface WorldReferenceQueryParams {
  worldIdInput: string;
  snapshot: WorldStoreSnapshot;
  listDescendantsOf: (parentId: string) => SphereEntity[];
}

function getTemplateRootSphere(
  templateId: number,
  getSphereById: (sphereId: string) => SphereEntity | null,
): SphereEntity | null {
  if (templateId <= TEMPLATE_NONE_ID) {
    return null;
  }

  return getSphereById(getTemplateRootSphereId(templateId));
}

function hasSharedTemplateDefinition(
  templateId: number,
  getSphereById: (sphereId: string) => SphereEntity | null,
  listChildrenOf: (parentId: string) => SphereEntity[],
): boolean {
  const templateRoot = getTemplateRootSphere(templateId, getSphereById);
  if (!templateRoot) {
    return false;
  }

  return listChildrenOf(templateRoot.id).length > 0;
}

function readTemplateRotationDimension(hostSphere: SphereEntity, dimension: string): number {
  const value = hostSphere.dimensions[dimension];
  return Number.isFinite(value) ? value : 0;
}

function rotateTemplateOffsetByHost(
  hostSphere: SphereEntity,
  offsetX: number,
  offsetY: number,
  offsetZ: number,
): [number, number, number] {
  const yaw = readTemplateRotationDimension(hostSphere, SUBWORLD_YAW_DIMENSION);
  const pitch = readTemplateRotationDimension(hostSphere, SUBWORLD_PITCH_DIMENSION);
  if (yaw === 0 && pitch === 0) {
    return [offsetX, offsetY, offsetZ];
  }

  templateRotationEuler.set(pitch, yaw, 0, "YXZ");
  templateRotationOffset.set(offsetX, offsetY, offsetZ).applyEuler(templateRotationEuler);
  return [templateRotationOffset.x, templateRotationOffset.y, templateRotationOffset.z];
}

function instantiateSharedTemplateChildren({
  hostSpheres,
  listChildrenOf,
  getSphereById,
}: SharedTemplateExpansionParams): SphereEntity[] {
  const derived: SphereEntity[] = [];

  for (const hostSphere of hostSpheres) {
    const templateId = readTemplateId(hostSphere);
    if (templateId <= TEMPLATE_NONE_ID) {
      continue;
    }

    const templateRoot = getTemplateRootSphere(templateId, getSphereById);
    if (!templateRoot) {
      continue;
    }

    const templateChildren = listChildrenOf(templateRoot.id);
    if (templateChildren.length === 0) {
      continue;
    }

    const hostScale = resolveTemplateHostScale(hostSphere, templateRoot.radius);
    if (hostScale <= 0) {
      continue;
    }

    for (const templateChild of templateChildren) {
      const offsetX = templateChild.position3d[0] - templateRoot.position3d[0];
      const offsetY = templateChild.position3d[1] - templateRoot.position3d[1];
      const offsetZ = templateChild.position3d[2] - templateRoot.position3d[2];
      const [rotatedOffsetX, rotatedOffsetY, rotatedOffsetZ] = rotateTemplateOffsetByHost(
        hostSphere,
        offsetX * hostScale,
        offsetY * hostScale,
        offsetZ * hostScale,
      );

      derived.push({
        id: `${hostSphere.id}::template-${templateId}::entity-${templateChild.id}`,
        parentId: hostSphere.id,
        radius: Math.max(MIN_ENTITY_RADIUS, templateChild.radius * hostScale),
        position3d: [
          hostSphere.position3d[0] + rotatedOffsetX,
          hostSphere.position3d[1] + rotatedOffsetY,
          hostSphere.position3d[2] + rotatedOffsetZ,
        ],
        dimensions: { ...templateChild.dimensions },
        instanceWorldId: templateChild.instanceWorldId ?? null,
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

function instantiateReferencedWorldChildren({
  hostSpheres,
  currentWorldId,
  instancedWorldById,
  ensureInstancedWorldLoaded,
  worldInstanceRenderDepth,
  colorConfig,
}: ReferencedWorldExpansionParams): SphereEntity[] {
  const derived: SphereEntity[] = [];
  let hostsForDepth = [...hostSpheres];

  for (let depth = 0; depth < worldInstanceRenderDepth; depth += 1) {
    if (hostsForDepth.length === 0) {
      break;
    }

    const nextHosts: SphereEntity[] = [];
    for (const hostSphere of hostsForDepth) {
      const referencedWorldId = resolveReferencedWorldId(hostSphere);
      if (
        !referencedWorldId ||
        (currentWorldId !== null && referencedWorldId === currentWorldId)
      ) {
        continue;
      }

      const referencedWorld = instancedWorldById.get(referencedWorldId);
      if (!referencedWorld) {
        ensureInstancedWorldLoaded(referencedWorldId);
        continue;
      }

      const referencedRoot = referencedWorld.parent;
      const hostScale = resolveTemplateHostScale(hostSphere, referencedRoot.radius);
      if (hostScale <= 0) {
        continue;
      }

      for (const referencedChild of referencedWorld.children) {
        const offsetX = referencedChild.position3d[0] - referencedRoot.position3d[0];
        const offsetY = referencedChild.position3d[1] - referencedRoot.position3d[1];
        const offsetZ = referencedChild.position3d[2] - referencedRoot.position3d[2];
        const [rotatedOffsetX, rotatedOffsetY, rotatedOffsetZ] = rotateTemplateOffsetByHost(
          hostSphere,
          offsetX * hostScale,
          offsetY * hostScale,
          offsetZ * hostScale,
        );

        const derivedChild: SphereEntity = {
          id: `${hostSphere.id}::world-${referencedWorldId}::entity-${referencedChild.id}`,
          parentId: hostSphere.id,
          radius: Math.max(MIN_ENTITY_RADIUS, referencedChild.radius * hostScale),
          position3d: [
            hostSphere.position3d[0] + rotatedOffsetX,
            hostSphere.position3d[1] + rotatedOffsetY,
            hostSphere.position3d[2] + rotatedOffsetZ,
          ],
          dimensions: tintWorldInstanceChildDimensions({
            childDimensions: referencedChild.dimensions,
            hostDimensions: hostSphere.dimensions,
            defaultColorChannels: colorConfig.defaultColorChannels,
            colorDimensionKeys: colorConfig.colorDimensionKeys,
          }),
          instanceWorldId: referencedChild.instanceWorldId ?? null,
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
        };

        derived.push(derivedChild);
        nextHosts.push(derivedChild);
      }
    }

    hostsForDepth = nextHosts;
  }

  return derived;
}

export function cloneSphereEntity(entity: SphereEntity): SphereEntity {
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

export function readTemplateId(entity: SphereEntity | null): number {
  return Math.max(TEMPLATE_NONE_ID, resolveTemplateIdFromEntity(entity) ?? TEMPLATE_NONE_ID);
}

export function isTemplateRootSphere(entity: SphereEntity): boolean {
  return entity.tags.includes(TEMPLATE_ROOT_TAG);
}

export function resolveTemplateHostScale(
  hostSphere: SphereEntity,
  templateRootRadius: number,
): number {
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

export function resolveReferencedWorldId(entity: SphereEntity): string | null {
  return normalizeInstanceWorldIdForRuntime({
    instanceWorldId: entity.instanceWorldId ?? null,
    dimensions: entity.dimensions,
  });
}

export function isPortalHostSphere(entity: SphereEntity): boolean {
  const templateId = entity.dimensions[SUBWORLD_TEMPLATE_DIMENSION];
  const hasInstanceWorldReference =
    typeof entity.instanceWorldId === "string" && entity.instanceWorldId.trim().length > 0;
  const hasWorldReference =
    (Number.isFinite(templateId) && Math.trunc(templateId) > TEMPLATE_NONE_ID) ||
    hasInstanceWorldReference;
  return hasWorldReference && !isTemplateRootSphere(entity);
}

export function expandWorldRenderEntities({
  snapshot,
  currentWorldId,
  listChildrenOf,
  listDescendantsOf,
  getSphereById,
  instancedWorldById,
  ensureInstancedWorldLoaded,
  worldInstanceRenderDepth,
  colorConfig,
}: ExpandWorldRenderEntitiesParams): SphereEntity[] {
  const rootView = snapshot.parent.parentId === null;
  const visibleChildren = rootView
    ? snapshot.children.filter((child) => !isTemplateRootSphere(child))
    : snapshot.children;
  const templateHosts = rootView ? [snapshot.parent, ...visibleChildren] : [...visibleChildren];

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
    const templateId = readTemplateId(child);
    if (
      templateId > TEMPLATE_NONE_ID &&
      hasSharedTemplateDefinition(templateId, getSphereById, listChildrenOf)
    ) {
      continue;
    }

    for (const descendant of listDescendantsOf(child.id)) {
      pushExpanded(descendant);
    }
  }

  for (const instancedChild of instantiateSharedTemplateChildren({
    hostSpheres: templateHosts,
    listChildrenOf,
    getSphereById,
  })) {
    pushExpanded(instancedChild);
  }

  for (const instancedChild of instantiateReferencedWorldChildren({
    hostSpheres: [...expandedChildren],
    currentWorldId,
    instancedWorldById,
    ensureInstancedWorldLoaded,
    worldInstanceRenderDepth,
    colorConfig,
  })) {
    pushExpanded(instancedChild);
  }

  const fallbackTemplateHosts = templateHosts.filter((host) => {
    if (host.instanceWorldId?.trim()) {
      return false;
    }

    const templateId = readTemplateId(host);
    return (
      templateId > TEMPLATE_NONE_ID &&
      !hasSharedTemplateDefinition(templateId, getSphereById, listChildrenOf)
    );
  });

  for (const instancedChild of instantiateSubworldChildren(fallbackTemplateHosts)) {
    pushExpanded(instancedChild);
  }

  return expandedChildren;
}

export function worldReferencesInstancedWorld({
  worldIdInput,
  snapshot,
  listDescendantsOf,
}: WorldReferenceQueryParams): boolean {
  const worldId = worldIdInput.trim();
  if (!worldId) {
    return false;
  }

  const rootView = snapshot.parent.parentId === null;
  const visibleChildren = rootView
    ? snapshot.children.filter((child) => !isTemplateRootSphere(child))
    : snapshot.children;
  const templateHosts = rootView ? [snapshot.parent, ...visibleChildren] : [...visibleChildren];
  const candidateHosts: SphereEntity[] = [...templateHosts];

  for (const host of templateHosts) {
    candidateHosts.push(...listDescendantsOf(host.id));
  }

  return candidateHosts.some((host) => resolveReferencedWorldId(host) === worldId);
}
