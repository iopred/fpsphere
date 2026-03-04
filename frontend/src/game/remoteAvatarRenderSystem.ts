import * as THREE from "three";
import {
  createRemoteAvatarHandle,
  normalizeAvatarId,
  type AvatarId,
  type AvatarRenderHandle,
} from "./avatarRenderAdapter";
import type { RemotePlayerState } from "./multiplayerClient";
import {
  planRemoteAvatarSnapshot,
  planRemoteAvatarWorldSwitch,
} from "./remoteAvatarLifecycle";

const REMOTE_INTERPOLATION_SMOOTH_TIME_SECONDS = 0.085;
const REMOTE_INTERPOLATION_SNAP_DISTANCE = 5;
const REMOTE_INTERPOLATION_SNAP_ANGLE_RADIANS = Math.PI * 0.75;
const REMOTE_INTERPOLATION_MAX_FRAME_SECONDS = 0.1;
const TWO_PI = Math.PI * 2;

interface RemotePlayerRenderState {
  renderPosition: THREE.Vector3;
  targetPosition: THREE.Vector3;
  renderYaw: number;
  targetYaw: number;
  renderPitch: number;
  targetPitch: number;
  avatarId: AvatarId;
  lastServerTick: number;
}

interface RemoteAvatarRenderInstance {
  avatarId: AvatarId;
  handle: AvatarRenderHandle;
}

export class RemoteAvatarRenderSystem {
  private readonly remotePlayerRenderStates = new Map<string, RemotePlayerRenderState>();
  private readonly remotePlayerAvatars = new Map<string, RemoteAvatarRenderInstance>();

  constructor(private readonly scene: THREE.Scene) {}

  get remotePlayerCount(): number {
    return this.remotePlayerRenderStates.size;
  }

  reset(): void {
    for (const playerId of planRemoteAvatarWorldSwitch(this.remotePlayerAvatars.keys())) {
      this.removeRemotePlayerMesh(playerId);
    }
    this.remotePlayerRenderStates.clear();
  }

  applySnapshot(
    players: RemotePlayerState[],
    localPlayerId: string | null,
    serverTick: number,
  ): void {
    const plan = planRemoteAvatarSnapshot(
      players,
      localPlayerId,
      this.remotePlayerRenderStates.keys(),
    );
    for (const remotePlayer of plan.upsertPlayers) {
      const playerId = remotePlayer.player_id;
      const renderState = this.upsertRemotePlayerRenderState(remotePlayer, serverTick);
      this.upsertRemotePlayerMesh(playerId, renderState);
    }

    for (const existingId of plan.removePlayerIds) {
      this.remotePlayerRenderStates.delete(existingId);
      this.removeRemotePlayerMesh(existingId);
    }
  }

  updateInterpolation(frameSeconds: number): void {
    if (this.remotePlayerRenderStates.size === 0) {
      return;
    }

    const interpolationAlpha = this.remoteInterpolationAlpha(frameSeconds);
    if (interpolationAlpha <= 0) {
      return;
    }

    for (const [playerId, renderState] of this.remotePlayerRenderStates) {
      const avatarInstance = this.remotePlayerAvatars.get(playerId);
      if (!avatarInstance) {
        continue;
      }

      if (
        renderState.renderPosition.distanceTo(renderState.targetPosition) >
        REMOTE_INTERPOLATION_SNAP_DISTANCE
      ) {
        renderState.renderPosition.copy(renderState.targetPosition);
      } else {
        renderState.renderPosition.lerp(renderState.targetPosition, interpolationAlpha);
      }

      renderState.renderYaw = this.interpolateAngleRadians(
        renderState.renderYaw,
        renderState.targetYaw,
        interpolationAlpha,
      );
      renderState.renderPitch = this.interpolateAngleRadians(
        renderState.renderPitch,
        renderState.targetPitch,
        interpolationAlpha,
      );

      this.applyRemotePlayerRenderPose(
        avatarInstance.handle,
        renderState.renderPosition,
        renderState.renderYaw,
        renderState.renderPitch,
      );
    }
  }

  private upsertRemotePlayerRenderState(
    remotePlayer: RemotePlayerState,
    serverTick: number,
  ): RemotePlayerRenderState {
    const playerId = remotePlayer.player_id;
    const normalizedServerTick = Number.isFinite(serverTick) ? Math.trunc(serverTick) : 0;
    const existingState = this.remotePlayerRenderStates.get(playerId);
    if (!existingState) {
      const spawnPosition = new THREE.Vector3(
        remotePlayer.position_3d[0],
        remotePlayer.position_3d[1],
        remotePlayer.position_3d[2],
      );
      const normalizedYaw = this.normalizeAngleRadians(remotePlayer.yaw);
      const normalizedPitch = this.normalizeAngleRadians(remotePlayer.pitch);
      const normalizedAvatarId = normalizeAvatarId(remotePlayer.avatar_id);
      const createdState: RemotePlayerRenderState = {
        renderPosition: spawnPosition.clone(),
        targetPosition: spawnPosition,
        renderYaw: normalizedYaw,
        targetYaw: normalizedYaw,
        renderPitch: normalizedPitch,
        targetPitch: normalizedPitch,
        avatarId: normalizedAvatarId,
        lastServerTick: normalizedServerTick,
      };
      this.remotePlayerRenderStates.set(playerId, createdState);
      return createdState;
    }

    if (normalizedServerTick < existingState.lastServerTick) {
      return existingState;
    }

    existingState.targetPosition.set(
      remotePlayer.position_3d[0],
      remotePlayer.position_3d[1],
      remotePlayer.position_3d[2],
    );
    existingState.targetYaw = this.normalizeAngleRadians(remotePlayer.yaw);
    existingState.targetPitch = this.normalizeAngleRadians(remotePlayer.pitch);
    existingState.avatarId = normalizeAvatarId(remotePlayer.avatar_id);
    existingState.lastServerTick = normalizedServerTick;
    return existingState;
  }

  private remoteInterpolationAlpha(frameSeconds: number): number {
    const boundedFrameSeconds = Math.max(
      0,
      Math.min(frameSeconds, REMOTE_INTERPOLATION_MAX_FRAME_SECONDS),
    );
    if (boundedFrameSeconds <= 0) {
      return 0;
    }

    return (
      1 -
      Math.exp(
        -boundedFrameSeconds / REMOTE_INTERPOLATION_SMOOTH_TIME_SECONDS,
      )
    );
  }

  private normalizeAngleRadians(angle: number): number {
    if (!Number.isFinite(angle)) {
      return 0;
    }

    let normalized = (angle + Math.PI) % TWO_PI;
    if (normalized < 0) {
      normalized += TWO_PI;
    }
    return normalized - Math.PI;
  }

  private interpolateAngleRadians(
    current: number,
    target: number,
    alpha: number,
  ): number {
    const normalizedCurrent = this.normalizeAngleRadians(current);
    const normalizedTarget = this.normalizeAngleRadians(target);
    const delta = this.normalizeAngleRadians(normalizedTarget - normalizedCurrent);
    if (Math.abs(delta) > REMOTE_INTERPOLATION_SNAP_ANGLE_RADIANS) {
      return normalizedTarget;
    }
    return this.normalizeAngleRadians(normalizedCurrent + delta * alpha);
  }

  private applyRemotePlayerRenderPose(
    avatar: AvatarRenderHandle,
    position: THREE.Vector3,
    yaw: number,
    pitch: number,
  ): void {
    avatar.applyPose(position.x, position.y, position.z, yaw, pitch);
  }

  private upsertRemotePlayerMesh(
    playerId: string,
    renderState: RemotePlayerRenderState,
  ): void {
    const existingAvatar = this.remotePlayerAvatars.get(playerId);
    if (existingAvatar && existingAvatar.avatarId === renderState.avatarId) {
      this.applyRemotePlayerRenderPose(
        existingAvatar.handle,
        renderState.renderPosition,
        renderState.renderYaw,
        renderState.renderPitch,
      );
      return;
    }

    if (existingAvatar) {
      this.scene.remove(existingAvatar.handle.object3d);
      existingAvatar.handle.dispose();
      this.remotePlayerAvatars.delete(playerId);
    }

    const avatar = createRemoteAvatarHandle({
      avatarId: renderState.avatarId,
      playerId,
    });
    this.applyRemotePlayerRenderPose(
      avatar,
      renderState.renderPosition,
      renderState.renderYaw,
      renderState.renderPitch,
    );
    this.scene.add(avatar.object3d);
    this.remotePlayerAvatars.set(playerId, {
      avatarId: renderState.avatarId,
      handle: avatar,
    });
  }

  private removeRemotePlayerMesh(playerId: string): void {
    const avatarInstance = this.remotePlayerAvatars.get(playerId);
    if (!avatarInstance) {
      return;
    }

    this.scene.remove(avatarInstance.handle.object3d);
    avatarInstance.handle.dispose();
    this.remotePlayerAvatars.delete(playerId);
  }
}
