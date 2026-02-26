import * as THREE from "three";

export interface CornerPoint {
  x: number;
  y: number;
}

export interface MarkerPoseEstimate {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  corners: [CornerPoint, CornerPoint, CornerPoint, CornerPoint];
}

export interface EstimateMarkerPoseParams {
  corners: CornerPoint[];
  frameWidth: number;
  frameHeight: number;
  markerSizeMeters: number;
  fovYDegrees: number;
}

const EPSILON = 1e-6;

function vectorLength(vector: readonly number[]): number {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  return Math.sqrt(sum);
}

function normalizeVector(vector: readonly number[]): number[] | null {
  const length = vectorLength(vector);
  if (length <= EPSILON) {
    return null;
  }
  return vector.map((value) => value / length);
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function subtract(a: readonly number[], b: readonly number[]): number[] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function multiplyScalar(vector: readonly number[], scalar: number): number[] {
  return [vector[0] * scalar, vector[1] * scalar, vector[2] * scalar];
}

function cross(a: readonly number[], b: readonly number[]): number[] {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function solveLinearSystem8x8(rows: number[][], values: number[]): number[] | null {
  const size = 8;
  const matrix = rows.map((row, index) => [...row, values[index]]);

  for (let pivot = 0; pivot < size; pivot += 1) {
    let maxRow = pivot;
    let maxValue = Math.abs(matrix[pivot][pivot]);

    for (let row = pivot + 1; row < size; row += 1) {
      const candidate = Math.abs(matrix[row][pivot]);
      if (candidate > maxValue) {
        maxValue = candidate;
        maxRow = row;
      }
    }

    if (maxValue <= EPSILON) {
      return null;
    }

    if (maxRow !== pivot) {
      const temp = matrix[pivot];
      matrix[pivot] = matrix[maxRow];
      matrix[maxRow] = temp;
    }

    const pivotValue = matrix[pivot][pivot];
    for (let column = pivot; column <= size; column += 1) {
      matrix[pivot][column] /= pivotValue;
    }

    for (let row = 0; row < size; row += 1) {
      if (row === pivot) {
        continue;
      }
      const factor = matrix[row][pivot];
      if (Math.abs(factor) <= EPSILON) {
        continue;
      }
      for (let column = pivot; column <= size; column += 1) {
        matrix[row][column] -= factor * matrix[pivot][column];
      }
    }
  }

  return matrix.map((row) => row[size]);
}

export function orderQrCorners(
  points: CornerPoint[],
): [CornerPoint, CornerPoint, CornerPoint, CornerPoint] | null {
  if (points.length < 4) {
    return null;
  }

  const candidates = points.slice(0, 4);
  const sums = candidates.map((point) => point.x + point.y);
  const diffs = candidates.map((point) => point.x - point.y);

  const topLeftIndex = sums.indexOf(Math.min(...sums));
  const bottomRightIndex = sums.indexOf(Math.max(...sums));
  const topRightIndex = diffs.indexOf(Math.max(...diffs));
  const bottomLeftIndex = diffs.indexOf(Math.min(...diffs));

  const uniqueIndices = new Set([
    topLeftIndex,
    topRightIndex,
    bottomRightIndex,
    bottomLeftIndex,
  ]);
  if (uniqueIndices.size !== 4) {
    return null;
  }

  return [
    candidates[topLeftIndex],
    candidates[topRightIndex],
    candidates[bottomRightIndex],
    candidates[bottomLeftIndex],
  ];
}

export function estimateMarkerPose(
  params: EstimateMarkerPoseParams,
): MarkerPoseEstimate | null {
  const { frameWidth, frameHeight, markerSizeMeters, fovYDegrees } = params;
  if (
    !Number.isFinite(frameWidth) ||
    !Number.isFinite(frameHeight) ||
    frameWidth <= 0 ||
    frameHeight <= 0 ||
    markerSizeMeters <= 0
  ) {
    return null;
  }

  const corners = orderQrCorners(params.corners);
  if (!corners) {
    return null;
  }

  const halfSize = markerSizeMeters * 0.5;
  const worldPlanePoints: Array<[number, number]> = [
    [-halfSize, halfSize],
    [halfSize, halfSize],
    [halfSize, -halfSize],
    [-halfSize, -halfSize],
  ];

  const equations: number[][] = [];
  const values: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    const [x, y] = worldPlanePoints[index];
    const corner = corners[index];
    const u = corner.x;
    const v = corner.y;

    equations.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    equations.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }

  const solution = solveLinearSystem8x8(equations, values);
  if (!solution) {
    return null;
  }

  const h11 = solution[0];
  const h12 = solution[1];
  const h13 = solution[2];
  const h21 = solution[3];
  const h22 = solution[4];
  const h23 = solution[5];
  const h31 = solution[6];
  const h32 = solution[7];

  const fovY = THREE.MathUtils.degToRad(fovYDegrees);
  const fy = frameHeight / (2 * Math.tan(fovY * 0.5));
  const fx = fy * (frameWidth / frameHeight);
  const cx = frameWidth * 0.5;
  const cy = frameHeight * 0.5;

  if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx <= EPSILON || fy <= EPSILON) {
    return null;
  }

  const applyKInverse = (column: readonly [number, number, number]): number[] => {
    return [
      (column[0] - cx * column[2]) / fx,
      (column[1] - cy * column[2]) / fy,
      column[2],
    ];
  };

  const kInvH1 = applyKInverse([h11, h21, h31]);
  const kInvH2 = applyKInverse([h12, h22, h32]);
  const kInvH3 = applyKInverse([h13, h23, 1]);

  const h1Norm = vectorLength(kInvH1);
  const h2Norm = vectorLength(kInvH2);
  if (h1Norm <= EPSILON || h2Norm <= EPSILON) {
    return null;
  }

  const scale = 1 / ((h1Norm + h2Norm) * 0.5);
  let r1 = multiplyScalar(kInvH1, scale);
  const r2Raw = multiplyScalar(kInvH2, scale);
  let t = multiplyScalar(kInvH3, scale);

  const r1Normalized = normalizeVector(r1);
  if (!r1Normalized) {
    return null;
  }
  r1 = r1Normalized;

  const r2Projected = subtract(r2Raw, multiplyScalar(r1, dot(r2Raw, r1)));
  let r2 = normalizeVector(r2Projected);
  if (!r2) {
    return null;
  }

  let r3 = normalizeVector(cross(r1, r2));
  if (!r3) {
    return null;
  }

  // Keep the marker in front of the camera in CV coordinates.
  if (t[2] < 0) {
    r1 = multiplyScalar(r1, -1);
    r2 = multiplyScalar(r2, -1);
    r3 = multiplyScalar(r3, -1);
    t = multiplyScalar(t, -1);
  }

  const rCv = [
    [r1[0], r2[0], r3[0]],
    [r1[1], r2[1], r3[1]],
    [r1[2], r2[2], r3[2]],
  ];

  const rThree = [
    [rCv[0][0], rCv[0][1], rCv[0][2]],
    [-rCv[1][0], -rCv[1][1], -rCv[1][2]],
    [-rCv[2][0], -rCv[2][1], -rCv[2][2]],
  ];

  const rotationMatrix = new THREE.Matrix4().set(
    rThree[0][0],
    rThree[0][1],
    rThree[0][2],
    0,
    rThree[1][0],
    rThree[1][1],
    rThree[1][2],
    0,
    rThree[2][0],
    rThree[2][1],
    rThree[2][2],
    0,
    0,
    0,
    0,
    1,
  );

  const quaternion = new THREE.Quaternion().setFromRotationMatrix(rotationMatrix);
  const position = new THREE.Vector3(t[0], -t[1], -t[2]);

  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    return null;
  }

  return {
    position,
    quaternion,
    corners,
  };
}
