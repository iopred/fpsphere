import type { PlayerBody } from "./physics";
import type { MultiplayerSnapshot } from "./multiplayerClient";

export interface PredictedInputState {
  sequence: number;
  simulationTick: number;
  position3d: [number, number, number];
  yaw: number;
  pitch: number;
}

const MAX_PENDING_PREDICTED_INPUTS = 512;
const RECONCILE_POSITION_EPSILON = 0.0001;

export class LocalPredictionReconciler {
  private readonly pendingPredictedInputs = new Map<number, PredictedInputState>();
  private lastAckedInputSequence = 0;
  private lastSnapshotServerTick = 0;
  private lastReconciliationError = 0;

  constructor(private readonly player: PlayerBody) {}

  get ackedInputSequence(): number {
    return this.lastAckedInputSequence;
  }

  get pendingPredictedInputCount(): number {
    return this.pendingPredictedInputs.size;
  }

  get lastSnapshotTick(): number {
    return this.lastSnapshotServerTick;
  }

  get lastReconciliationErrorDistance(): number {
    return this.lastReconciliationError;
  }

  reset(): void {
    this.lastAckedInputSequence = 0;
    this.lastSnapshotServerTick = 0;
    this.lastReconciliationError = 0;
    this.pendingPredictedInputs.clear();
  }

  recordPredictedInput(state: PredictedInputState): void {
    this.pendingPredictedInputs.set(state.sequence, state);
    this.prunePredictedInputBuffer();
  }

  applySnapshot(snapshot: MultiplayerSnapshot, localPlayerId: string | null): void {
    if (!localPlayerId) {
      return;
    }

    this.lastSnapshotServerTick = snapshot.server_tick;
    const localPlayer = snapshot.players.find(
      (player) => player.player_id === localPlayerId,
    );
    if (!localPlayer) {
      return;
    }

    const rawAck = localPlayer.last_processed_input_tick;
    if (!Number.isFinite(rawAck) || rawAck < 0) {
      return;
    }

    const ackSequence = Math.max(
      this.lastAckedInputSequence,
      Math.trunc(rawAck),
    );

    this.reconcileLocalPrediction(ackSequence, localPlayer.position_3d);
    this.lastAckedInputSequence = ackSequence;
    this.prunePredictedInputBuffer();
  }

  private reconcileLocalPrediction(
    ackSequence: number,
    authoritativePosition: [number, number, number],
  ): void {
    const acknowledgedPrediction = this.pendingPredictedInputs.get(ackSequence);

    if (!acknowledgedPrediction) {
      if (this.pendingPredictedInputs.size === 0) {
        const deltaX = authoritativePosition[0] - this.player.position.x;
        const deltaY = authoritativePosition[1] - this.player.position.y;
        const deltaZ = authoritativePosition[2] - this.player.position.z;
        const error = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
        this.lastReconciliationError = error;

        if (error > RECONCILE_POSITION_EPSILON) {
          this.player.position.set(
            authoritativePosition[0],
            authoritativePosition[1],
            authoritativePosition[2],
          );
        }
      }
      return;
    }

    const deltaX = authoritativePosition[0] - acknowledgedPrediction.position3d[0];
    const deltaY = authoritativePosition[1] - acknowledgedPrediction.position3d[1];
    const deltaZ = authoritativePosition[2] - acknowledgedPrediction.position3d[2];
    const error = Math.sqrt(deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ);
    this.lastReconciliationError = error;

    if (error <= RECONCILE_POSITION_EPSILON) {
      return;
    }

    this.player.position.set(
      this.player.position.x + deltaX,
      this.player.position.y + deltaY,
      this.player.position.z + deltaZ,
    );

    for (const [sequence, predicted] of this.pendingPredictedInputs) {
      if (sequence <= ackSequence) {
        continue;
      }

      predicted.position3d = [
        predicted.position3d[0] + deltaX,
        predicted.position3d[1] + deltaY,
        predicted.position3d[2] + deltaZ,
      ];
    }
  }

  private prunePredictedInputBuffer(): void {
    for (const sequence of [...this.pendingPredictedInputs.keys()]) {
      if (sequence <= this.lastAckedInputSequence) {
        this.pendingPredictedInputs.delete(sequence);
      }
    }

    while (this.pendingPredictedInputs.size > MAX_PENDING_PREDICTED_INPUTS) {
      const oldest = this.pendingPredictedInputs.keys().next().value;
      if (typeof oldest !== "number") {
        break;
      }
      this.pendingPredictedInputs.delete(oldest);
    }
  }
}
