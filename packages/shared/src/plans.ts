import { z } from "zod";

/**
 * Subscription plans, keyed by workspace. Deliberately just a name and a
 * concurrent-participant limit — no feature flags, no billing fields. See
 * ParticipantLimitProvider (participantLimit.ts) for how a limit is resolved
 * for a given workspace; this module only defines what the limits ARE.
 *
 * Enterprise is capped at 200, not higher: this phase only validates
 * concurrency up to ~200 (see the load harness). Raising the ceiling requires
 * spatial partitioning / area-of-interest filtering for the proximity tick,
 * which is a dedicated future scaling phase, not a bigger number here.
 */
export const PlanIdSchema = z.enum(["startup", "team", "company", "large", "enterprise"]);
export type PlanId = z.infer<typeof PlanIdSchema>;
export const PLAN_IDS = PlanIdSchema.options;

export const PLAN_PARTICIPANT_LIMITS: Record<PlanId, number> = {
  startup: 10,
  team: 25,
  company: 50,
  large: 100,
  enterprise: 200,
};

export const PLAN_LABELS: Record<PlanId, string> = {
  startup: "Startup",
  team: "Team",
  company: "Company",
  large: "Large",
  enterprise: "Enterprise",
};

/** A workspace whose plan allows MORE than this many people online may draw its own office map (the map builder). */
export const MAP_BUILDER_ABOVE_PEOPLE = 10;

/**
 * Whether a plan includes the map builder: the smallest plan (10 people) gets ready-made templates only, every
 * larger plan may save, publish and restore its own map (docs/architecture/company-map-builder.md, D16). It reads
 * the same limit table as the participant limit, so changing a plan's size moves both together.
 */
export function canUseMapBuilder(plan: PlanId): boolean {
  return PLAN_PARTICIPANT_LIMITS[plan] > MAP_BUILDER_ABOVE_PEOPLE;
}
