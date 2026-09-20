import { DEFAULT_MOVEMENT_CONFIG, type MovementConfig, type Point as Vec2 } from "@workspace-video/shared";

/**
 * Client-side movement math, kept in lockstep with — but never exceeding —
 * the server's authoritative rules in packages/proximity/src/movement.ts.
 * The local avatar updates immediately from input (never waiting on a round
 * trip), but every value here is chosen so ordinary play never trips a
 * server-side correction:
 *   - WALK_SPEED_PX_PER_SEC is far under maxSpeedPxPerSec, so integrating
 *     input at this speed can never itself trigger max_speed_exceeded.
 *   - clampToBounds mirrors the server's room bounds so the local avatar
 *     never visibly walks past a wall the server would reject anyway.
 */
export const WALK_SPEED_PX_PER_SEC = 320;

export function clampToBounds(p: Vec2, bounds: MovementConfig = DEFAULT_MOVEMENT_CONFIG): Vec2 {
  return {
    x: Math.min(Math.max(p.x, 0), bounds.roomWidthPx),
    y: Math.min(Math.max(p.y, 0), bounds.roomHeightPx),
  };
}

/** Integrates a unit (or zero) direction vector into a new position, moving
 *  at WALK_SPEED_PX_PER_SEC, clamped to the room bounds. `direction` need
 *  not be normalized — e.g. two keys held at once — it is normalized here
 *  so diagonal movement isn't faster than axis-aligned movement. */
export function integrateKeyboardMove(
  position: Vec2,
  direction: Vec2,
  dtSeconds: number,
  bounds: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
): Vec2 {
  const mag = Math.hypot(direction.x, direction.y);
  if (mag === 0) return position;

  const normalized = { x: direction.x / mag, y: direction.y / mag };
  const distance = WALK_SPEED_PX_PER_SEC * dtSeconds;
  return clampToBounds(
    { x: position.x + normalized.x * distance, y: position.y + normalized.y * distance },
    bounds,
  );
}

/** Steps a position toward a click-to-walk target at WALK_SPEED_PX_PER_SEC,
 *  never overshooting it — shares the same speed as keyboard movement so
 *  neither input mode can outrun the server's speed validator. */
export function stepTowardWalkTarget(
  position: Vec2,
  target: Vec2,
  dtSeconds: number,
  bounds: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
): Vec2 {
  const dx = target.x - position.x;
  const dy = target.y - position.y;
  const distanceToTarget = Math.hypot(dx, dy);
  const maxStep = WALK_SPEED_PX_PER_SEC * dtSeconds;

  if (distanceToTarget <= maxStep || distanceToTarget === 0) {
    return clampToBounds(target, bounds);
  }

  const t = maxStep / distanceToTarget;
  return clampToBounds({ x: position.x + dx * t, y: position.y + dy * t }, bounds);
}

/**
 * Decides whether a `move` should be sent to the server right now: at most
 * once per `clientThrottleMs`, and only when the position actually changed
 * since the last send. Pure — takes explicit "last sent" state rather than
 * reading a clock or a store, so it's trivially testable.
 */
export function shouldEmitMove(
  lastSentAtMs: number | null,
  lastSentPosition: Vec2 | null,
  nowMs: number,
  position: Vec2,
  config: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
): boolean {
  if (lastSentAtMs === null || lastSentPosition === null) return true;

  const unchanged = lastSentPosition.x === position.x && lastSentPosition.y === position.y;
  if (unchanged) return false;

  return nowMs - lastSentAtMs >= config.clientThrottleMs;
}
