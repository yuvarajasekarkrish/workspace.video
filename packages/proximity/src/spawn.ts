import type { Point } from "@workspace-video/shared";
import { DEFAULT_MOVEMENT_CONFIG, type MovementConfig } from "@workspace-video/shared";

/**
 * Deterministic per-user spawn offset so multiple avatars joining a room
 * don't render exactly on top of each other. Derives a stable angle from a
 * hash of the user id and places them on a small ring around a base point —
 * same user always gets the same offset (useful for tests, and avoids a
 * visual "jump" if a peer briefly reconnects), different users predictably
 * differ. Clamped to the room's movement bounds so a base point near an edge
 * can't push the ring offset out of the valid world. This is a placeholder
 * until Room.config carries a real spawn point (see the
 * TODO(phase 7) at the call site in apps/realtime/src/server.ts).
 */
export function spawnPositionForUser(
  userId: string,
  base: Point,
  ringRadiusPx = 60,
  bounds: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
): Point {
  const angle = hashToAngle(userId);
  const x = base.x + Math.cos(angle) * ringRadiusPx;
  const y = base.y + Math.sin(angle) * ringRadiusPx;
  return {
    x: clamp(x, 0, bounds.roomWidthPx),
    y: clamp(y, 0, bounds.roomHeightPx),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Simple deterministic string hash (FNV-1a) mapped onto [0, 2π). Not
 *  cryptographic — just needs to be stable and spread ids around the ring. */
function hashToAngle(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  // Force unsigned, then map to [0, 2π).
  const unsigned = hash >>> 0;
  return (unsigned / 0xffffffff) * 2 * Math.PI;
}
