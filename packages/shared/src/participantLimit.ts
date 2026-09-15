/**
 * Room-entry capacity checking, factored into two small interfaces plus one
 * pure decision function, so "how many people may be in this workspace at
 * once" and "who is here right now" can each evolve independently of the
 * join code that consumes them.
 *
 * Both interfaces are keyed by **workspaceId**, never roomId. Phase 8's
 * product constraint is one office room per workspace, but that is a
 * decision made at workspace-creation time, not something baked into this
 * abstraction — a future multi-room workspace only has to swap the
 * ActiveParticipantCounter implementation (e.g. to a Redis-backed count
 * across every room belonging to the workspace); admitParticipant and every
 * call site of it are unaffected.
 */

/** Resolves the maximum number of concurrent participants a workspace's
 *  plan allows. Today this reads Workspace.plan (see
 *  packages/db/src/participantLimits.ts); a future billing integration
 *  replaces only the implementation of this interface. */
export interface ParticipantLimitProvider {
  getWorkspaceParticipantLimit(workspaceId: string): Promise<number>;
}

/** Resolves who is currently active in a workspace. Phase 8's
 *  implementation reads the peers of the (one) room this instance owns for
 *  the workspace; nothing here assumes that room count stays at one. */
export interface ActiveParticipantCounter {
  activeUserIds(workspaceId: string): ReadonlySet<string>;
}

export type AdmitParticipantResult =
  | { admitted: true }
  | { admitted: false; reason: "workspace_full"; limit: number; active: number };

/**
 * Pure admission decision — no I/O, so it is trivially unit-testable and
 * safe to call synchronously from the join handler (no await between the
 * check and inserting the peer, which is what prevents two sockets from
 * both being admitted into the last slot).
 *
 * An already-active user (reconnect, second tab, page reload) is always
 * readmitted and never counted twice: admission counts DISTINCT user ids,
 * not connections.
 *
 * `limit` fails closed: anything that isn't a positive integer is treated
 * as zero capacity rather than unlimited, so a misconfigured or broken
 * ParticipantLimitProvider can never silently let a workspace overfill.
 */
export function admitParticipant(
  activeUserIds: ReadonlySet<string>,
  userId: string,
  limit: number,
): AdmitParticipantResult {
  if (activeUserIds.has(userId)) {
    return { admitted: true };
  }

  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 0;
  if (activeUserIds.size >= safeLimit) {
    return { admitted: false, reason: "workspace_full", limit: safeLimit, active: activeUserIds.size };
  }

  return { admitted: true };
}
