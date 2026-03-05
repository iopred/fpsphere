export interface SphereColorChannels {
  r: number;
  g: number;
  b: number;
}

export interface SphereColorDimensionKeys {
  red: string;
  green: string;
  blue: string;
}

interface TintWorldInstanceChildDimensionsParams {
  childDimensions: Record<string, number>;
  hostDimensions: Record<string, number>;
  defaultColorChannels: SphereColorChannels;
  colorDimensionKeys: SphereColorDimensionKeys;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}

function readNormalizedColorChannel(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return clamp01(fallback);
  }

  return clamp01(value);
}

function readColorChannels(
  dimensions: Record<string, number>,
  defaultColorChannels: SphereColorChannels,
  colorDimensionKeys: SphereColorDimensionKeys,
): SphereColorChannels {
  return {
    r: readNormalizedColorChannel(dimensions[colorDimensionKeys.red], defaultColorChannels.r),
    g: readNormalizedColorChannel(dimensions[colorDimensionKeys.green], defaultColorChannels.g),
    b: readNormalizedColorChannel(dimensions[colorDimensionKeys.blue], defaultColorChannels.b),
  };
}

function tintScale(channel: number, neutral: number): number {
  if (!Number.isFinite(neutral) || neutral <= 0) {
    return channel;
  }

  return channel / neutral;
}

export function tintWorldInstanceChildDimensions({
  childDimensions,
  hostDimensions,
  defaultColorChannels,
  colorDimensionKeys,
}: TintWorldInstanceChildDimensionsParams): Record<string, number> {
  const childColorChannels = readColorChannels(
    childDimensions,
    defaultColorChannels,
    colorDimensionKeys,
  );
  const hostColorChannels = readColorChannels(
    hostDimensions,
    defaultColorChannels,
    colorDimensionKeys,
  );

  const tintedColorChannels: SphereColorChannels = {
    r: clamp01(
      childColorChannels.r * tintScale(hostColorChannels.r, defaultColorChannels.r),
    ),
    g: clamp01(
      childColorChannels.g * tintScale(hostColorChannels.g, defaultColorChannels.g),
    ),
    b: clamp01(
      childColorChannels.b * tintScale(hostColorChannels.b, defaultColorChannels.b),
    ),
  };

  return {
    ...childDimensions,
    [colorDimensionKeys.red]: tintedColorChannels.r,
    [colorDimensionKeys.green]: tintedColorChannels.g,
    [colorDimensionKeys.blue]: tintedColorChannels.b,
  };
}
