export const TEMPLATE_PLACEMENT_PLAYBACK_MIN_SCALE = 0.2;
export const TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_SCALE = 1.12;
const TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_PROGRESS = 0.7;

export interface TemplatePlacementPlaybackParams {
  currentTick: number;
  startTick: number;
  durationTicks: number;
  maxAgeTicks: number;
}

function toNonNegativeTick(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  const tick = Math.trunc(value);
  if (tick < 0) {
    return null;
  }

  return tick;
}

export function templatePlacementPlaybackProgress(
  params: TemplatePlacementPlaybackParams,
): number | null {
  const currentTick = toNonNegativeTick(params.currentTick);
  const startTick = toNonNegativeTick(params.startTick);
  const durationTicks = toNonNegativeTick(params.durationTicks);
  const maxAgeTicks = toNonNegativeTick(params.maxAgeTicks);
  if (
    currentTick === null ||
    startTick === null ||
    durationTicks === null ||
    maxAgeTicks === null ||
    durationTicks <= 0
  ) {
    return null;
  }

  const elapsedTicks = currentTick - startTick;
  if (elapsedTicks < 0 || elapsedTicks > maxAgeTicks) {
    return null;
  }

  return Math.min(1, elapsedTicks / durationTicks);
}

export function templatePlacementPlaybackScale(progress: number): number {
  if (!Number.isFinite(progress)) {
    return 1;
  }

  const clamped = Math.max(0, Math.min(1, progress));
  if (clamped < TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_PROGRESS) {
    const alpha = clamped / TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_PROGRESS;
    return (
      TEMPLATE_PLACEMENT_PLAYBACK_MIN_SCALE +
      (TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_SCALE - TEMPLATE_PLACEMENT_PLAYBACK_MIN_SCALE) *
        alpha
    );
  }

  const alpha =
    (clamped - TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_PROGRESS) /
    (1 - TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_PROGRESS);
  return (
    TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_SCALE +
    (1 - TEMPLATE_PLACEMENT_PLAYBACK_OVERSHOOT_SCALE) * alpha
  );
}
