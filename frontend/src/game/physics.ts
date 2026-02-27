import * as THREE from "three";

export interface ObstacleBody {
  id: string;
  center: THREE.Vector3;
  radius: number;
  money: number;
  selectable: boolean;
  collidable: boolean;
  portalHost: boolean;
  instancedSubworld: boolean;
}

export interface PlayerBody {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  radius: number;
  grounded: boolean;
}

const scratchDelta = new THREE.Vector3();
const scratchNormal = new THREE.Vector3();
const GROUND_CONTACT_EPSILON = 0.02;

export function constrainInsideParentSphere(
  player: PlayerBody,
  parentCenter: THREE.Vector3,
  parentRadius: number,
): boolean {
  scratchDelta.copy(player.position).sub(parentCenter);
  const distance = scratchDelta.length();
  const maxDistance = parentRadius - player.radius;

  if (distance <= maxDistance) {
    return false;
  }

  if (distance <= 1e-6) {
    player.position.copy(parentCenter);
    return true;
  }

  scratchNormal.copy(scratchDelta).divideScalar(distance);
  player.position.copy(parentCenter).addScaledVector(scratchNormal, maxDistance);

  const outwardVelocity = player.velocity.dot(scratchNormal);
  if (outwardVelocity > 0) {
    player.velocity.addScaledVector(scratchNormal, -outwardVelocity);
  }

  return true;
}

export function resolveSphereCollisions(
  player: PlayerBody,
  obstacles: ObstacleBody[],
): number {
  let collisions = 0;
  player.grounded = false;

  for (const obstacle of obstacles) {
    if (!obstacle.collidable) {
      continue;
    }

    scratchDelta.copy(player.position).sub(obstacle.center);
    const distance = scratchDelta.length();
    const minimumDistance = obstacle.radius + player.radius;

    if (distance >= minimumDistance) {
      if (distance - minimumDistance <= GROUND_CONTACT_EPSILON) {
        if (distance <= 1e-6) {
          scratchNormal.set(0, 1, 0);
        } else {
          scratchNormal.copy(scratchDelta).divideScalar(distance);
        }

        if (scratchNormal.y > 0.45 && player.velocity.y <= 0) {
          player.grounded = true;
        }
      }
      continue;
    }

    collisions += 1;

    if (distance <= 1e-6) {
      scratchNormal.set(0, 1, 0);
    } else {
      scratchNormal.copy(scratchDelta).divideScalar(distance);
    }

    player.position.copy(obstacle.center).addScaledVector(scratchNormal, minimumDistance);

    const inwardVelocity = player.velocity.dot(scratchNormal);
    if (inwardVelocity < 0) {
      player.velocity.addScaledVector(scratchNormal, -inwardVelocity);
    }

    if (scratchNormal.y > 0.45) {
      player.grounded = true;
    }
  }

  return collisions;
}
