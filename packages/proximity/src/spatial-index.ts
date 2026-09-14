import type { Point } from "@cosmos/shared";

/**
 * Seam between the proximity engine and however peer positions happen to be
 * indexed. v1 ships `NaiveSpatialIndex` (O(n) per query, O(n^2) for a full
 * room scan) because room sizes are small; a uniform spatial hash grid can
 * implement the same interface later without the engine or its tests changing.
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
}
