import type { Point } from "@workspace-video/shared";

/**
 * Seam between the proximity engine and however peer positions happen to be
 * indexed. `NaiveSpatialIndex` is the O(n)-per-query reference/oracle;
 * `UniformGridIndex` is the O(1)-amortized implementation RoomManager uses
 * from Phase 9 on. Both satisfy the same interface so tests can compare them
 * directly and the engine never depends on which one is wired in.
 */
export interface SpatialIndex<Id extends string = string> {
  insert(id: Id, position: Point): void;
  move(id: Id, position: Point): void;
  remove(id: Id): void;
  /** All ids currently indexed, for full pairwise scans. */
  allIds(): Id[];
  getPosition(id: Id): Point | undefined;
  /** Ids within `radius` px of `position`, excluding nothing by default. */
  queryRadius(position: Point, radius: number): Id[];
  /** Every unordered pair worth checking for proximity, visited exactly
   *  once. For `NaiveSpatialIndex` that's literally every pair; for
   *  `UniformGridIndex` it's every pair that could possibly be within one
   *  cell's size of each other (see that class's doc comment for the proof). */
  forEachCandidatePair(cb: (a: Id, b: Id) => void): void;
}

export class NaiveSpatialIndex<Id extends string = string> implements SpatialIndex<Id> {
  private positions = new Map<Id, Point>();

  insert(id: Id, position: Point): void {
    this.positions.set(id, position);
  }

  move(id: Id, position: Point): void {
    this.positions.set(id, position);
  }

  remove(id: Id): void {
    this.positions.delete(id);
  }

  allIds(): Id[] {
    return Array.from(this.positions.keys());
  }

  getPosition(id: Id): Point | undefined {
    return this.positions.get(id);
  }

  queryRadius(position: Point, radius: number): Id[] {
    const r2 = radius * radius;
    const result: Id[] = [];
    for (const [id, p] of this.positions) {
      const dx = p.x - position.x;
      const dy = p.y - position.y;
      if (dx * dx + dy * dy <= r2) result.push(id);
    }
    return result;
  }

  /** Every unordered pair currently indexed — the naive O(n^2) reference
   *  RoomManager used through Phase 8, kept here as the correctness oracle
   *  `UniformGridIndex.forEachCandidatePair` is tested against. */
  forEachCandidatePair(cb: (a: Id, b: Id) => void): void {
    const ids = this.allIds();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        cb(ids[i]!, ids[j]!);
      }
    }
  }
}

/**
 * Uniform grid / spatial hash. Cell size should be set to the largest
 * distance at which two entities can still interact (for this app,
 * `audioRadiusPx + hysteresisPx` — see DEFAULT_PROXIMITY_CONFIG) so that any
 * pair within that distance is guaranteed to land in the same cell or one of
 * its immediate neighbours (see `forEachCandidatePair`'s doc comment for the
 * proof).
 *
 * Cell keys are small integers, never strings — `cellKey = cy * cols + cx`,
 * with `cols` derived from an explicit world width so the encoding never
 * relies on an assumed coordinate range. Positions outside `[0, width] x
 * [0, height]` are clamped into the nearest edge cell rather than silently
 * producing a colliding or negative key; callers on this app's hot path
 * (`applyMove`/`validateMove`) already guarantee positions are in-bounds, so
 * clamping here is a defensive backstop, not the normal path.
 */
export class UniformGridIndex<Id extends string = string> implements SpatialIndex<Id> {
  private readonly cellSize: number;
  private readonly cols: number;
  private readonly rows: number;
  /** cellKey -> ids currently in that cell. Arrays are mutated in place
   *  (splice-out on move/remove) rather than replaced, so a stable cell
   *  doesn't reallocate on every tick. */
  private readonly cells = new Map<number, Id[]>();
  private readonly positions = new Map<Id, Point>();
  private readonly cellOf = new Map<Id, number>();

  constructor(worldWidthPx: number, worldHeightPx: number, cellSize: number) {
    if (cellSize <= 0) throw new Error("cellSize must be positive.");
    if (worldWidthPx <= 0 || worldHeightPx <= 0) {
      throw new Error("worldWidthPx and worldHeightPx must be positive.");
    }
    this.cellSize = cellSize;
    // +1 so a point exactly on the far edge still gets its own in-range cell
    // index rather than landing one past `cols - 1`.
    this.cols = Math.ceil(worldWidthPx / cellSize) + 1;
    this.rows = Math.ceil(worldHeightPx / cellSize) + 1;
    if (this.cols * this.rows > Number.MAX_SAFE_INTEGER) {
      throw new Error("Grid dimensions too large to key safely — increase cellSize.");
    }
  }

  private cellCoords(position: Point): { cx: number; cy: number } {
    const cx = Math.min(Math.max(Math.floor(position.x / this.cellSize), 0), this.cols - 1);
    const cy = Math.min(Math.max(Math.floor(position.y / this.cellSize), 0), this.rows - 1);
    return { cx, cy };
  }

  private keyFor(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  insert(id: Id, position: Point): void {
    if (this.positions.has(id)) {
      this.move(id, position);
      return;
    }
    const { cx, cy } = this.cellCoords(position);
    const key = this.keyFor(cx, cy);
    this.positions.set(id, position);
    this.cellOf.set(id, key);
    let bucket = this.cells.get(key);
    if (!bucket) {
      bucket = [];
      this.cells.set(key, bucket);
    }
    bucket.push(id);
  }

  move(id: Id, position: Point): void {
    const previousKey = this.cellOf.get(id);
    if (previousKey === undefined) {
      this.insert(id, position);
      return;
    }
    this.positions.set(id, position);

    const { cx, cy } = this.cellCoords(position);
    const key = this.keyFor(cx, cy);
    if (key === previousKey) return; // same cell — no bucket churn

    const oldBucket = this.cells.get(previousKey);
    if (oldBucket) {
      const idx = oldBucket.indexOf(id);
      if (idx !== -1) {
        // Swap-remove: O(1), order within a bucket is never meaningful.
        oldBucket[idx] = oldBucket[oldBucket.length - 1]!;
        oldBucket.pop();
      }
    }

    this.cellOf.set(id, key);
    let newBucket = this.cells.get(key);
    if (!newBucket) {
      newBucket = [];
      this.cells.set(key, newBucket);
    }
    newBucket.push(id);
  }

  remove(id: Id): void {
    const key = this.cellOf.get(id);
    if (key === undefined) return;
    const bucket = this.cells.get(key);
    if (bucket) {
      const idx = bucket.indexOf(id);
      if (idx !== -1) {
        bucket[idx] = bucket[bucket.length - 1]!;
        bucket.pop();
      }
    }
    this.cellOf.delete(id);
    this.positions.delete(id);
  }

  allIds(): Id[] {
    return Array.from(this.positions.keys());
  }

  getPosition(id: Id): Point | undefined {
    return this.positions.get(id);
  }

  queryRadius(position: Point, radius: number): Id[] {
    const r2 = radius * radius;
    const result: Id[] = [];
    for (const [id, p] of this.positions) {
      const dx = p.x - position.x;
      const dy = p.y - position.y;
      if (dx * dx + dy * dy <= r2) result.push(id);
    }
    return result;
  }

  /**
   * Visits every unordered pair that could possibly be within `cellSize` of
   * each other, exactly once, with no dedupe set required.
   *
   * Correctness: if two points are within `cellSize` px of each other, their
   * cell coordinates differ by at most 1 on each axis (since a cell spans
   * exactly `cellSize` px on a side) — so any in-range pair is either in the
   * same cell, or in one of the 8 neighbouring cells.
   *
   * No duplicates: rather than scanning all 8 neighbours (which would visit
   * each cross-cell pair twice, once from each side), this walks a half
   * neighbourhood — East, South-East, South, South-West — plus same-cell
   * pairs with `i < j`. Every unordered pair {A, B} in adjacent cells has
   * exactly one of the two cells reachable from the other via this half
   * neighbourhood (e.g. the pair spanning a cell and its West neighbour is
   * caught when iterating the West cell's East neighbour), so it is visited
   * from exactly one side.
   */
  forEachCandidatePair(cb: (a: Id, b: Id) => void): void {
    const HALF_NEIGHBOR_OFFSETS: readonly [number, number][] = [
      [1, 0], // E
      [1, 1], // SE
      [0, 1], // S
      [-1, 1], // SW
    ];

    for (const [key, bucket] of this.cells) {
      if (bucket.length === 0) continue;
      // Same-cell pairs.
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          cb(bucket[i]!, bucket[j]!);
        }
      }

      const cy = Math.floor(key / this.cols);
      const cx = key - cy * this.cols;

      for (const [dx, dy] of HALF_NEIGHBOR_OFFSETS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= this.cols || ny < 0 || ny >= this.rows) continue;
        const neighborBucket = this.cells.get(this.keyFor(nx, ny));
        if (!neighborBucket || neighborBucket.length === 0) continue;
        for (const a of bucket) {
          for (const b of neighborBucket) {
            cb(a, b);
          }
        }
      }
    }
  }
}
