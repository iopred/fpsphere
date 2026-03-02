import * as THREE from "three";

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
  directionColor: number;
  directionEmissive: number;
}

const DEFAULT_REMOTE_AVATAR_STYLE: AvatarRenderStyle = {
  radius: 0.9,
  bodyColor: 0x4be29f,
  bodyEmissive: 0x0d5e43,
  headColor: 0x78efbb,
  headEmissive: 0x0f6a4b,
  directionColor: 0xffd05f,
  directionEmissive: 0x754900,
};

export function createRemoteAvatarHandle(
  styleOverrides: Partial<AvatarRenderStyle> = {},
): AvatarRenderHandle {
  const style: AvatarRenderStyle = {
    ...DEFAULT_REMOTE_AVATAR_STYLE,
    ...styleOverrides,
  };

  const root = new THREE.Group();
  root.rotation.order = "YXZ";

  const bodyGeometry = new THREE.SphereGeometry(style.radius, 20, 16);
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: style.bodyColor,
    emissive: style.bodyEmissive,
    roughness: 0.45,
    metalness: 0.2,
  });
  const bodyMesh = new THREE.Mesh(bodyGeometry, bodyMaterial);
  root.add(bodyMesh);

  const headRadius = style.radius * 0.42;
  const headGeometry = new THREE.SphereGeometry(headRadius, 16, 12);
  const headMaterial = new THREE.MeshStandardMaterial({
    color: style.headColor,
    emissive: style.headEmissive,
    roughness: 0.4,
    metalness: 0.18,
  });
  const headMesh = new THREE.Mesh(headGeometry, headMaterial);
  headMesh.position.set(0, style.radius * 0.92, 0);
  root.add(headMesh);

  const directionGeometry = new THREE.ConeGeometry(style.radius * 0.22, style.radius * 0.92, 14);
  const directionMaterial = new THREE.MeshStandardMaterial({
    color: style.directionColor,
    emissive: style.directionEmissive,
    roughness: 0.35,
    metalness: 0.12,
  });
  const directionMesh = new THREE.Mesh(directionGeometry, directionMaterial);
  directionMesh.rotation.x = -Math.PI / 2;
  directionMesh.position.set(0, style.radius * 0.24, -style.radius * 1.04);
  root.add(directionMesh);

  const disposableGeometries: THREE.BufferGeometry[] = [
    bodyGeometry,
    headGeometry,
    directionGeometry,
  ];
  const disposableMaterials: THREE.Material[] = [
    bodyMaterial,
    headMaterial,
    directionMaterial,
  ];

  return {
    object3d: root,
    applyPose: (x, y, z, yaw, pitch) => {
      root.position.set(x, y, z);
      root.rotation.y = yaw;
      root.rotation.x = pitch;
    },
    dispose: () => {
      for (const geometry of disposableGeometries) {
        geometry.dispose();
      }
      for (const material of disposableMaterials) {
        material.dispose();
      }
    },
  };
}
