import { z } from "zod";

/**
 * Shared proximity + movement-validation tuning, imported by both the realtime
 * server (authoritative) and the client (for local UI prediction, e.g. drawing
 * the proximity ring). The server's values are the ones that matter for behavior.
 */
export const ProximityConfigSchema = z.object({
  /** Distance at or below which video subscribes and audio is at full gain. */
  videoRadiusPx: z.number().positive().default(200),
  /** Distance beyond which audio unsubscribes entirely. */
  audioRadiusPx: z.number().positive().default(500),
  /** A boundary must be crossed by this many extra px before the state flips back,
   *  to avoid flapping subscriptions when someone loiters near a threshold. */
  hysteresisPx: z.number().nonnegative().default(25),
  /** Server tick interval for recomputing proximity and batching position deltas. */
  tickIntervalMs: z.number().positive().default(100),
});
export type ProximityConfig = z.infer<typeof ProximityConfigSchema>;

export const DEFAULT_PROXIMITY_CONFIG: ProximityConfig = ProximityConfigSchema.parse({});

/**
 * Movement validation tuning for the server-authoritative position pipeline.
 */
export const MovementConfigSchema = z.object({
  /** Client is expected to throttle `move` emits to at most one per this interval. */
  clientThrottleMs: z.number().positive().default(50),
  /** Maximum plausible avatar speed, in px/second, used to reject teleport-like moves. */
  maxSpeedPxPerSec: z.number().positive().default(2000),
  /** Room bounds a position must fall within. */
  roomWidthPx: z.number().positive().default(8000),
  roomHeightPx: z.number().positive().default(8000),
});
export type MovementConfig = z.infer<typeof MovementConfigSchema>;

export const DEFAULT_MOVEMENT_CONFIG: MovementConfig = MovementConfigSchema.parse({});
