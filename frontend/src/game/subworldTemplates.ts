import type { SphereEntity, Vector3Tuple } from "@fpsphere/shared-types";

export const SUBWORLD_TEMPLATE_DIMENSION = "world_template";
export const SUBWORLD_SCALE_DIMENSION = "world_scale";
export const SUBWORLD_YAW_DIMENSION = "world_yaw";
export const SUBWORLD_PITCH_DIMENSION = "world_pitch";
export const TEMPLATE_ROOT_TAG = "template-root";
export const TEMPLATE_DEFINITION_TAG = "template-definition";

interface SubworldTemplateChild {
  id: string;
  radius: number;
  position3d: Vector3Tuple;
  dimensions: Record<string, number>;
  tags: string[];
}

interface SubworldTemplate {
  id: number;
  rootRadius: number;
  children: SubworldTemplateChild[];
}

const SUBWORLD_TEMPLATES: Record<number, SubworldTemplate> = {
  1: {
    id: 1,
    rootRadius: 12,
    children: [
      {
        id: "ground-shell",
        radius: 10.4,
        position3d: [0, -11.5, 0],
        dimensions: { money: 0.08 },
        tags: ["ground"],
      },
      {
        id: "hub-core",
        radius: 2.2,
        position3d: [-2.6, -1.4, -2.4],
        dimensions: { money: 0.7 },
        tags: ["building"],
      },
      {
        id: "resource-node",
        radius: 1.1,
        position3d: [2.2, -2.3, 2.9],
        dimensions: { money: 1.0 },
        tags: ["resource"],
      },
    ],
  },
};

export function getAvailableSubworldTemplateIds(): number[] {
  return Object.keys(SUBWORLD_TEMPLATES)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
}

export function getTemplateRootSphereId(templateId: number): string {
  return `sphere-template-root-${templateId}`;
}

export function resolveTemplateSeedId(templateId: number): number | null {
  const exact = SUBWORLD_TEMPLATES[templateId];
  if (exact) {
    return exact.id;
  }

  const available = getAvailableSubworldTemplateIds();
  if (available.length === 0) {
    return null;
  }

  return available[0];
}

export function getTemplateRootRadius(templateId: number): number {
  const resolvedTemplateId = resolveTemplateSeedId(templateId);
  const template = resolvedTemplateId === null ? null : SUBWORLD_TEMPLATES[resolvedTemplateId];
  if (template && Number.isFinite(template.rootRadius) && template.rootRadius > 0) {
    return template.rootRadius;
  }

  return 12;
}

function resolveTemplateId(entity: SphereEntity): number | null {
  const value = entity.dimensions[SUBWORLD_TEMPLATE_DIMENSION];
  if (!Number.isFinite(value)) {
    return null;
  }

  const templateId = Math.trunc(value);
  if (templateId <= 0) {
    return null;
  }

  return templateId;
}

function resolveScale(entity: SphereEntity, template: SubworldTemplate): number | null {
  if (template.rootRadius <= 0 || !Number.isFinite(template.rootRadius)) {
    return null;
  }

  const baseScale = entity.radius / template.rootRadius;
  if (!Number.isFinite(baseScale) || baseScale <= 0) {
    return null;
  }

  const dimensionScale = entity.dimensions[SUBWORLD_SCALE_DIMENSION];
  const extraScale = Number.isFinite(dimensionScale) && dimensionScale > 0 ? dimensionScale : 1;

  return baseScale * extraScale;
}

function readRotation(entity: SphereEntity): { yaw: number; pitch: number } {
  const yawRaw = entity.dimensions[SUBWORLD_YAW_DIMENSION];
  const pitchRaw = entity.dimensions[SUBWORLD_PITCH_DIMENSION];
  return {
    yaw: Number.isFinite(yawRaw) ? yawRaw : 0,
    pitch: Number.isFinite(pitchRaw) ? pitchRaw : 0,
  };
}

function rotateOffset(
  offset: Vector3Tuple,
  rotation: { yaw: number; pitch: number },
): Vector3Tuple {
  const [x, y, z] = offset;
  const cosYaw = Math.cos(rotation.yaw);
  const sinYaw = Math.sin(rotation.yaw);
  const yawX = x * cosYaw + z * sinYaw;
  const yawZ = -x * sinYaw + z * cosYaw;

  const cosPitch = Math.cos(rotation.pitch);
  const sinPitch = Math.sin(rotation.pitch);
  const pitchY = y * cosPitch - yawZ * sinPitch;
  const pitchZ = y * sinPitch + yawZ * cosPitch;

  return [yawX, pitchY, pitchZ];
}

export function instantiateSubworldChildren(hostSpheres: SphereEntity[]): SphereEntity[] {
  const derived: SphereEntity[] = [];

  for (const host of hostSpheres) {
    const requestedTemplateId = resolveTemplateId(host);
    if (requestedTemplateId === null) {
      continue;
    }

    const seedTemplateId = resolveTemplateSeedId(requestedTemplateId);
    if (seedTemplateId === null) {
      continue;
    }

    const template = SUBWORLD_TEMPLATES[seedTemplateId];
    if (!template) {
      continue;
    }

    const scale = resolveScale(host, template);
    if (scale === null) {
      continue;
    }
    const rotation = readRotation(host);

    for (const child of template.children) {
      const [offsetX, offsetY, offsetZ] = rotateOffset(
        [
          child.position3d[0] * scale,
          child.position3d[1] * scale,
          child.position3d[2] * scale,
        ],
        rotation,
      );
      derived.push({
        id: `${host.id}::template-${requestedTemplateId}::${child.id}`,
        parentId: host.id,
        radius: Math.max(0.05, child.radius * scale),
        position3d: [
          host.position3d[0] + offsetX,
          host.position3d[1] + offsetY,
          host.position3d[2] + offsetZ,
        ],
        dimensions: { ...child.dimensions },
        timeWindow: { ...host.timeWindow },
        tags: [...child.tags, "instanced-subworld", `template-${requestedTemplateId}`],
      });
    }
  }

  return derived;
}
