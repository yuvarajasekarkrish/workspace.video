import { z } from "zod";

/** A finite, bounded 2D point. Used for both authoritative and client-reported positions. */
export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof PointSchema>;
