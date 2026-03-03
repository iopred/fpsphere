import * as THREE from "three";

export type AvatarId = "duck" | "human";
export const DEFAULT_AVATAR_ID: AvatarId = "duck";
const AVATAR_IDS: AvatarId[] = ["duck", "human"];

export interface AvatarRenderHandle {
  readonly object3d: THREE.Object3D;
  applyPose(x: number, y: number, z: number, yaw: number, pitch: number): void;
  dispose(): void;
}

export interface AvatarRenderStyle {
  radius: number;
  bodyColor: number;
  bodyEmissive: number;
  headColor: number;
  headEmissive: number;
  limbColor: number;
  limbEmissive: number;
  directionColor: number;
  directionEmissive: number;
}

interface CreateRemoteAvatarHandleParams {
  avatarId?: string;
  playerId?: string;
  styleOverrides?: Partial<AvatarRenderStyle>;
}

const BASE_AVATAR_STYLES: Record<AvatarId, AvatarRenderStyle> = {
  duck: {
    radius: 0.9,
    bodyColor: 0xebc64f,
    bodyEmissive: 0x5a4208,
    headColor: 0xf9dc6e,
    headEmissive: 0x654d10,
    limbColor: 0xd69a2f,
    limbEmissive: 0x4f2d08,
    directionColor: 0xff8e2f,
    directionEmissive: 0x6a2a04,
  },
  human: {
    radius: 0.95,
    bodyColor: 0x4b87e2,
    bodyEmissive: 0x0d2f5e,
    headColor: 0xc8a27f,
    headEmissive: 0x4a2f1f,
    limbColor: 0x2e5ec0,
    limbEmissive: 0x0d264f,
    directionColor: 0x71f4d8,
    directionEmissive: 0x126554,
  },
};

export function availableAvatarIds(): AvatarId[] {
  return [...AVATAR_IDS];
}

export function avatarLabel(avatarId: AvatarId): string {
  if (avatarId === "human") {
    return "human";
  }
  return "duck";
}

export function normalizeAvatarId(avatarId: string | null | undefined): AvatarId {
  if (avatarId === "human") {
    return "human";
  }
  return DEFAULT_AVATAR_ID;
}

function hashPlayerId(playerId: string): number {
  let hash = 2166136261;
  for (let index = 0; index < playerId.length; index += 1) {
    hash ^= playerId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function tintHexColor(baseHex: number, playerId: string, amplitude: number): number {
  const color = new THREE.Color(baseHex);
  const hashUnit = (hashPlayerId(playerId) % 10_000) / 10_000;
  const hueOffset = (hashUnit - 0.5) * amplitude;
  color.offsetHSL(hueOffset, 0, 0);
  return color.getHex();
}

function resolveAvatarStyle(
  avatarId: AvatarId,
  playerId: string | undefined,
  styleOverrides: Partial<AvatarRenderStyle>,
): AvatarRenderStyle {
  const baseStyle = BASE_AVATAR_STYLES[avatarId];
  if (!playerId) {
    return {
      ...baseStyle,
      ...styleOverrides,
    };
  }

  return {
    ...baseStyle,
    bodyColor: tintHexColor(baseStyle.bodyColor, playerId, 0.16),
    headColor: tintHexColor(baseStyle.headColor, playerId, 0.1),
    limbColor: tintHexColor(baseStyle.limbColor, playerId, 0.16),
    ...styleOverrides,
  };
}

function createDuckAvatarMeshes(style: AvatarRenderStyle): {
  root: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
} {
  const root = new THREE.Group();
  root.rotation.order = "YXZ";

  const bodyGeometry = new THREE.SphereGeometry(style.radius, 20, 16);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: style.bodyColor,
    emissive: style.bodyEmissive,
    roughness: 0.42,
    metalness: 0.14,
  });
  root.add(new THREE.Mesh(bodyGeometry, bodyMaterial));

  const headRadius = style.radius * 0.42;
  const headGeometry = new THREE.SphereGeometry(headRadius, 16, 12);
  const headMaterial = new THREE.MeshStandardMaterial({
    color: style.headColor,
    emissive: style.headEmissive,
    roughness: 0.38,
    metalness: 0.1,
  });
  const headMesh = new THREE.Mesh(headGeometry, headMaterial);
  headMesh.position.set(0, style.radius * 0.92, style.radius * 0.06);
  root.add(headMesh);

  const beakGeometry = new THREE.ConeGeometry(style.radius * 0.18, style.radius * 0.38, 12);
  const beakMaterial = new THREE.MeshStandardMaterial({
    color: style.directionColor,
    emissive: style.directionEmissive,
    roughness: 0.36,
    metalness: 0.08,
  });
  const beakMesh = new THREE.Mesh(beakGeometry, beakMaterial);
  beakMesh.rotation.x = -Math.PI / 2;
  beakMesh.position.set(0, style.radius * 0.82, -style.radius * 0.72);
  root.add(beakMesh);

  return {
    root,
    geometries: [bodyGeometry, headGeometry, beakGeometry],
    materials: [bodyMaterial, headMaterial, beakMaterial],
  };
}

function createHumanAvatarMeshes(style: AvatarRenderStyle): {
  root: THREE.Group;
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
} {
  const root = new THREE.Group();
  root.rotation.order = "YXZ";

  const torsoGeometry = new THREE.CapsuleGeometry(
    style.radius * 0.33,
    style.radius * 0.8,
    8,
    12,
  );
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: style.bodyColor,
    emissive: style.bodyEmissive,
    roughness: 0.44,
    metalness: 0.2,
  });
  const torsoMesh = new THREE.Mesh(torsoGeometry, bodyMaterial);
  torsoMesh.position.set(0, style.radius * 0.36, 0);
  root.add(torsoMesh);

  const headRadius = style.radius * 0.24;
  const headGeometry = new THREE.SphereGeometry(headRadius, 16, 12);
  const headMaterial = new THREE.MeshStandardMaterial({
    color: style.headColor,
    emissive: style.headEmissive,
    roughness: 0.35,
    metalness: 0.1,
  });
  const headMesh = new THREE.Mesh(headGeometry, headMaterial);
  headMesh.position.set(0, style.radius * 1.12, 0);
  root.add(headMesh);

  const limbGeometry = new THREE.CapsuleGeometry(
    style.radius * 0.12,
    style.radius * 0.4,
    4,
    8,
  );
  const limbMaterial = new THREE.MeshStandardMaterial({
    color: style.limbColor,
    emissive: style.limbEmissive,
    roughness: 0.45,
    metalness: 0.16,
  });
  const leftArm = new THREE.Mesh(limbGeometry, limbMaterial);
  leftArm.position.set(-style.radius * 0.35, style.radius * 0.45, 0);
  leftArm.rotation.z = Math.PI / 2;
  root.add(leftArm);
  const rightArm = new THREE.Mesh(limbGeometry, limbMaterial);
  rightArm.position.set(style.radius * 0.35, style.radius * 0.45, 0);
  rightArm.rotation.z = Math.PI / 2;
  root.add(rightArm);

  const directionGeometry = new THREE.ConeGeometry(style.radius * 0.18, style.radius * 0.7, 14);
  const directionMaterial = new THREE.MeshStandardMaterial({
    color: style.directionColor,
    emissive: style.directionEmissive,
    roughness: 0.35,
    metalness: 0.12,
  });
  const directionMesh = new THREE.Mesh(directionGeometry, directionMaterial);
  directionMesh.rotation.x = -Math.PI / 2;
  directionMesh.position.set(0, style.radius * 0.6, -style.radius * 0.52);
  root.add(directionMesh);

  return {
    root,
    geometries: [torsoGeometry, headGeometry, limbGeometry, directionGeometry],
    materials: [bodyMaterial, headMaterial, limbMaterial, directionMaterial],
  };
}

export function createRemoteAvatarHandle(
  params: CreateRemoteAvatarHandleParams = {},
): AvatarRenderHandle {
  const avatarId = normalizeAvatarId(params.avatarId);
  const style = resolveAvatarStyle(
    avatarId,
    params.playerId,
    params.styleOverrides ?? {},
  );
  const meshSet =
    avatarId === "human"
      ? createHumanAvatarMeshes(style)
      : createDuckAvatarMeshes(style);

  return {
    object3d: meshSet.root,
    applyPose: (x, y, z, yaw, pitch) => {
      meshSet.root.position.set(x, y, z);
      meshSet.root.rotation.y = yaw;
      meshSet.root.rotation.x = pitch;
    },
    dispose: () => {
      for (const geometry of meshSet.geometries) {
        geometry.dispose();
      }
      for (const material of meshSet.materials) {
        material.dispose();
      }
    },
  };
}
