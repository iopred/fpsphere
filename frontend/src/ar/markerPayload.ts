export const DEFAULT_WORLD_ID = "world-main";
export const DEFAULT_MARKER_SIZE_METERS = 0.12;
export const MIN_MARKER_SIZE_METERS = 0.04;
export const MAX_MARKER_SIZE_METERS = 0.45;
export const DEFAULT_WORLD_SCALE_MULTIPLIER = 2;
export const MIN_WORLD_SCALE_MULTIPLIER = 0.25;
export const MAX_WORLD_SCALE_MULTIPLIER = 6;

export interface MarkerPayload {
  worldId: string;
  markerSizeMeters: number;
  worldScaleMultiplier: number;
}

function normalizeWorldId(worldId: string): string {
  const trimmed = worldId.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_WORLD_ID;
}

function roundMarkerSize(value: number): number {
  return Number(value.toFixed(3));
}

function roundWorldScale(value: number): number {
  return Number(value.toFixed(2));
}

export function clampMarkerSizeMeters(sizeMeters: number): number {
  if (!Number.isFinite(sizeMeters)) {
    return DEFAULT_MARKER_SIZE_METERS;
  }
  return Math.max(MIN_MARKER_SIZE_METERS, Math.min(MAX_MARKER_SIZE_METERS, sizeMeters));
}

export function clampWorldScaleMultiplier(scale: number): number {
  if (!Number.isFinite(scale)) {
    return DEFAULT_WORLD_SCALE_MULTIPLIER;
  }
  return Math.max(MIN_WORLD_SCALE_MULTIPLIER, Math.min(MAX_WORLD_SCALE_MULTIPLIER, scale));
}

export function buildMarkerPayload(
  worldId: string,
  markerSizeMeters: number = DEFAULT_MARKER_SIZE_METERS,
  worldScaleMultiplier: number = DEFAULT_WORLD_SCALE_MULTIPLIER,
): string {
  const cleanWorldId = normalizeWorldId(worldId);
  const markerSize = roundMarkerSize(clampMarkerSizeMeters(markerSizeMeters));
  const worldScale = roundWorldScale(
    clampWorldScaleMultiplier(worldScaleMultiplier),
  );
  return `fpsphere://world/${encodeURIComponent(cleanWorldId)}?marker=${markerSize}&scale=${worldScale}`;
}

function parseWorldPayloadFromUrl(rawValue: string): MarkerPayload | null {
  const match = /^fpsphere:\/\/world\/([^?\s#]+)(?:\?([^#\s]+))?$/i.exec(rawValue);
  if (!match) {
    return null;
  }

  const encodedWorldId = match[1];
  const search = match[2] ?? "";

  let worldId: string;
  try {
    worldId = decodeURIComponent(encodedWorldId);
  } catch {
    return null;
  }

  const params = new URLSearchParams(search);
  const markerRaw = params.get("marker");
  const scaleRaw = params.get("scale");
  const markerSize = markerRaw === null ? DEFAULT_MARKER_SIZE_METERS : Number(markerRaw);
  const worldScale =
    scaleRaw === null ? DEFAULT_WORLD_SCALE_MULTIPLIER : Number(scaleRaw);

  return {
    worldId: normalizeWorldId(worldId),
    markerSizeMeters: roundMarkerSize(clampMarkerSizeMeters(markerSize)),
    worldScaleMultiplier: roundWorldScale(clampWorldScaleMultiplier(worldScale)),
  };
}

function parseWorldPayloadFromJson(rawValue: string): MarkerPayload | null {
  if (!rawValue.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    if (parsed.type !== "fpsphere-world") {
      return null;
    }

    const worldId = typeof parsed.worldId === "string" ? parsed.worldId : DEFAULT_WORLD_ID;
    const markerSize =
      typeof parsed.markerSizeMeters === "number"
        ? parsed.markerSizeMeters
        : DEFAULT_MARKER_SIZE_METERS;
    const worldScaleRaw =
      typeof parsed.worldScaleMultiplier === "number"
        ? parsed.worldScaleMultiplier
        : typeof parsed.worldScale === "number"
          ? parsed.worldScale
          : DEFAULT_WORLD_SCALE_MULTIPLIER;

    return {
      worldId: normalizeWorldId(worldId),
      markerSizeMeters: roundMarkerSize(clampMarkerSizeMeters(markerSize)),
      worldScaleMultiplier: roundWorldScale(
        clampWorldScaleMultiplier(worldScaleRaw),
      ),
    };
  } catch {
    return null;
  }
}

function parseFallbackWorldId(rawValue: string): MarkerPayload | null {
  if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(rawValue)) {
    return null;
  }

  return {
    worldId: rawValue,
    markerSizeMeters: DEFAULT_MARKER_SIZE_METERS,
    worldScaleMultiplier: DEFAULT_WORLD_SCALE_MULTIPLIER,
  };
}

export function parseMarkerPayload(rawValue: string): MarkerPayload | null {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return null;
  }

  return (
    parseWorldPayloadFromUrl(trimmed) ??
    parseWorldPayloadFromJson(trimmed) ??
    parseFallbackWorldId(trimmed)
  );
}
