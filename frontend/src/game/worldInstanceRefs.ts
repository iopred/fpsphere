import type { SphereEntity } from "@fpsphere/shared-types";

export const TEMPLATE_INSTANCE_WORLD_PREFIX = "world-template-";

function readPositiveInteger(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  const integerValue = Math.trunc(value);
  if (integerValue <= 0) {
    return null;
  }

  return integerValue;
}

export function encodeTemplateInstanceWorldId(templateId: number): string | null {
  const normalizedTemplateId = readPositiveInteger(templateId);
  if (normalizedTemplateId === null) {
    return null;
  }

  return `${TEMPLATE_INSTANCE_WORLD_PREFIX}${normalizedTemplateId}`;
}

export function decodeTemplateIdFromInstanceWorldId(
  instanceWorldId: string | null | undefined,
): number | null {
  const normalized = instanceWorldId?.trim();
  if (!normalized || !normalized.startsWith(TEMPLATE_INSTANCE_WORLD_PREFIX)) {
    return null;
  }

  const parsedTemplateId = Number.parseInt(
    normalized.slice(TEMPLATE_INSTANCE_WORLD_PREFIX.length),
    10,
  );
  return readPositiveInteger(parsedTemplateId);
}

export function normalizeInstanceWorldIdForRuntime(input: {
  instanceWorldId?: string | null;
  dimensions?: Record<string, number>;
}): string | null {
  const directReference = input.instanceWorldId?.trim();
  if (directReference) {
    return directReference;
  }

  return null;
}

export function resolveTemplateIdFromEntity(
  entity: Pick<SphereEntity, "instanceWorldId" | "dimensions"> | null,
): number | null {
  if (!entity) {
    return null;
  }

  const fromInstanceReference = decodeTemplateIdFromInstanceWorldId(
    entity.instanceWorldId,
  );
  if (fromInstanceReference !== null) {
    return fromInstanceReference;
  }

  return null;
}
