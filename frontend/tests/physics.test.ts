import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { resolveSphereCollisions, type ObstacleBody, type PlayerBody } from "../src/game/physics";

function makeObstacleBody(): ObstacleBody {
  return {
    id: "obstacle-1",
    center: new THREE.Vector3(0, 0, 0),
    radius: 10,
    money: 0,
    selectable: false,
    collidable: true,
    portalHost: false,
    instancedSubworld: false,
  };
}

function makePlayerBody(y: number): PlayerBody {
  return {
    position: new THREE.Vector3(0, y, 0),
    velocity: new THREE.Vector3(0, 0, 0),
    radius: 1,
    grounded: false,
  };
}

describe("physics", () => {
  it("keeps player grounded when resting near contact", () => {
    const obstacle = makeObstacleBody();
    const player = makePlayerBody(11.01);

    const collisions = resolveSphereCollisions(player, [obstacle]);

    expect(collisions).toBe(0);
    expect(player.grounded).toBe(true);
  });

  it("does not mark grounded when clearly separated from obstacle", () => {
    const obstacle = makeObstacleBody();
    const player = makePlayerBody(11.2);

    const collisions = resolveSphereCollisions(player, [obstacle]);

    expect(collisions).toBe(0);
    expect(player.grounded).toBe(false);
  });
});
