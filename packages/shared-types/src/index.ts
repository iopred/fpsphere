export type Vector3Tuple = [number, number, number];

export type DimensionMap = Record<string, number>;

export interface TimeWindow {
  start: number;
  end: number | null;
}

export interface TemporalQueryWindow {
  startTick: number;
  endTick: number | null;
}

export interface TemporalQuery {
  tick?: number;
  window?: TemporalQueryWindow;
}

export interface SphereEntity {
  id: string;
  parentId: string | null;
  radius: number;
  position3d: Vector3Tuple;
  dimensions: DimensionMap;
  timeWindow: TimeWindow;
  tags: string[];
}

export interface ParseIssue {
  path: string;
  message: string;
}

export class SphereEntityValidationError extends Error {
  readonly issues: ParseIssue[];

  constructor(issues: ParseIssue[]) {
    super("Invalid SphereEntity payload");
    this.name = "SphereEntityValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(
  value: unknown,
  issues: ParseIssue[],
  path: string,
): string | null {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  issues.push({ path, message: "Expected non-empty string" });
  return null;
}

function readNullableString(
  value: unknown,
  issues: ParseIssue[],
  path: string,
): string | null {
  if (value === null) {
    return null;
  }

  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  issues.push({ path, message: "Expected string or null" });
  return null;
}

function readFiniteNumber(
  value: unknown,
  issues: ParseIssue[],
  path: string,
): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  issues.push({ path, message: "Expected finite number" });
  return null;
}

function readVector3(
  value: unknown,
  issues: ParseIssue[],
  path: string,
): Vector3Tuple | null {
  if (!Array.isArray(value) || value.length !== 3) {
    issues.push({ path, message: "Expected [number, number, number]" });
    return null;
  }

  const parsed: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const parsedValue = readFiniteNumber(value[index], issues, `${path}[${index}]`);
    if (parsedValue === null) {
      return null;
    }
    parsed.push(parsedValue);
  }

  return [parsed[0], parsed[1], parsed[2]];
}

function readDimensions(
  value: unknown,
  issues: ParseIssue[],
  path: string,
): DimensionMap | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object of numeric dimensions" });
    return null;
  }

  const dimensions: DimensionMap = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      issues.push({ path: `${path}.${key}`, message: "Expected finite number value" });
      continue;
    }
    dimensions[key] = item;
  }

  return dimensions;
}

function readTimeWindow(
  value: unknown,
  issues: ParseIssue[],
  path: string,
): TimeWindow | null {
  if (!isRecord(value)) {
    issues.push({ path, message: "Expected object { start, end }" });
    return null;
  }

  const start = readFiniteNumber(value.start, issues, `${path}.start`);
  let end: number | null = null;
  let endValid = true;

  if (value.end === null) {
    end = null;
  } else {
    const parsedEnd = readFiniteNumber(value.end, issues, `${path}.end`);
    if (parsedEnd === null) {
      endValid = false;
    } else {
      end = parsedEnd;
    }
  }

  if (start === null || !endValid) {
    return null;
  }

  return { start, end };
}

function readTags(
  value: unknown,
  issues: ParseIssue[],
  path: string,
): string[] | null {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "Expected string[]" });
    return null;
  }

  const tags: string[] = [];
  value.forEach((item, index) => {
    const tag = readString(item, issues, `${path}[${index}]`);
    if (tag !== null) {
      tags.push(tag);
    }
  });

  return tags;
}

export function parseSphereEntity(value: unknown): SphereEntity {
  const issues: ParseIssue[] = [];
  if (!isRecord(value)) {
    throw new SphereEntityValidationError([
      { path: "$", message: "Expected object payload" },
    ]);
  }

  const id = readString(value.id, issues, "id");
  const parentId = readNullableString(value.parentId, issues, "parentId");
  const radius = readFiniteNumber(value.radius, issues, "radius");
  const position3d = readVector3(value.position3d, issues, "position3d");
  const dimensions = readDimensions(value.dimensions, issues, "dimensions");
  const timeWindow = readTimeWindow(value.timeWindow, issues, "timeWindow");
  const tags = readTags(value.tags, issues, "tags");

  if (issues.length > 0 || id === null || radius === null || position3d === null || dimensions === null || timeWindow === null || tags === null) {
    throw new SphereEntityValidationError(issues);
  }

  return {
    id,
    parentId,
    radius,
    position3d,
    dimensions,
    timeWindow,
    tags,
  };
}

export function parseSphereEntities(values: unknown[]): SphereEntity[] {
  return values.map((value) => parseSphereEntity(value));
}
