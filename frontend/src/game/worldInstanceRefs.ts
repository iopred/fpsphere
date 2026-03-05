import type { SphereEntity } from "@fpsphere/shared-types";

const LEGACY_TEMPLATE_DIMENSION = "world_template";
export const LEGACY_TEMPLATE_INSTANCE_WORLD_PREFIX = "legacy-template:";

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

export function encodeLegacyTemplateInstanceWorldId(templateId: number): string | null {
  const normalizedTemplateId = readPositiveInteger(templateId);
  if (normalizedTemplateId === null) {
    return null;
  }

  return `${LEGACY_TEMPLATE_INSTANCE_WORLD_PREFIX}${normalizedTemplateId}`;
}

export function decodeLegacyTemplateIdFromInstanceWorldId(
  instanceWorldId: string | null | undefined,
): number | null {
  const normalized = instanceWorldId?.trim();
  if (!normalized || !normalized.startsWith(LEGACY_TEMPLATE_INSTANCE_WORLD_PREFIX)) {
    return null;
  }

  const parsedTemplateId = Number.parseInt(
    normalized.slice(LEGACY_TEMPLATE_INSTANCE_WORLD_PREFIX.length),
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

  const legacyTemplateId = readPositiveInteger(
    input.dimensions?.[LEGACY_TEMPLATE_DIMENSION],
  );
  if (legacyTemplateId === null) {
    return null;
  }

  return `${LEGACY_TEMPLATE_INSTANCE_WORLD_PREFIX}${legacyTemplateId}`;
}

export function resolveTemplateIdForLegacyCompatibility(
  entity: Pick<SphereEntity, "instanceWorldId" | "dimensions"> | null,
): number | null {
  if (!entity) {
    return null;
  }

  const fromInstanceReference = decodeLegacyTemplateIdFromInstanceWorldId(
    entity.instanceWorldId,
  );
  if (fromInstanceReference !== null) {
    return fromInstanceReference;
  }

  return readPositiveInteger(entity.dimensions[LEGACY_TEMPLATE_DIMENSION]);
}
