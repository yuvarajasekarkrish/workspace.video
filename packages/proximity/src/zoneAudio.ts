import type { ZoneKind } from "@cosmos/shared";
import type { ProximityState } from "./proximity";
import { NOT_NEARBY } from "./proximity";

/** The pieces of a LayoutZone that matter to the audio rule — a subset
 *  rather than the whole zone object, so this stays a plain data type
 *  independent of @cosmos/shared's layout module beyond ZoneKind itself. */
export interface ZoneRef {
  id: string;
  kind: ZoneKind;
  /** Only meaningful for an `audience` zone — the stage it faces. */
  stageId?: string;
}

const FULL_GAIN: ProximityState = { audioSubscribed: true, audioGain: 1, videoSubscribed: true };
const MUTED: ProximityState = NOT_NEARBY;

function isPrivate(kind: ZoneKind): boolean {
  return kind === "meeting" || kind === "cabin";
}

/**
 * Directed (listener <- speaker) override of raw distance-based proximity,
 * per the approved plan's audio table. Pure — no I/O, no reference to
 * RoomManager or Postgres — composes OVER tickProximity's output rather
 * than replacing it: `raw` is exactly what computeProximityState/
 * tickProximity already produced for this pair, and the caller (RoomManager)
 * is responsible for keeping that raw value in room.proximityStates
 * untouched (see the plan's two verified traps this is designed around:
 * writing an override back into proximityStates would corrupt hysteresis,
 * and tickProximity only reports pairs whose DISTANCE changed, not zone
 * membership, so a zone crossing between two stationary people needs its
 * own diff — both handled by the caller, not here).
 */
export function effectiveAudio(
  raw: ProximityState,
  listenerZone: ZoneRef | null,
  speakerZone: ZoneRef | null,
): ProximityState {
  const listenerPrivate = listenerZone !== null && isPrivate(listenerZone.kind);
  const speakerPrivate = speakerZone !== null && isPrivate(speakerZone.kind);

  // A meeting room or cabin is private in both directions: only two people
  // in the SAME private zone hear each other at all, full gain regardless
  // of in-room distance; anyone else pairing with a private-zone occupant
  // (from either side) is muted, matching "meeting/cabin X <- elsewhere"
  // and its "elsewhere <- meeting/cabin X" mirror in the plan's table.
  if (listenerPrivate || speakerPrivate) {
    if (listenerPrivate && speakerPrivate && listenerZone!.id === speakerZone!.id) {
      return FULL_GAIN;
    }
    return MUTED;
  }

  // Audience hears its own stage at full gain, broadcast-style, regardless
  // of in-hall distance. The reverse (a presenter hearing one audience
  // member) is deliberately NOT special-cased here — it falls through to
  // raw proximity below, per the table's "stage S <- audience of S: raw".
  if (listenerZone?.kind === "audience" && speakerZone?.kind === "stage" && listenerZone.stageId === speakerZone.id) {
    return FULL_GAIN;
  }

  // A focus zone is do-not-disturb for its OWN occupant — this only mutes
  // what the focus-zone person hears, not their audibility to others.
  if (listenerZone?.kind === "focus") {
    return MUTED;
  }

  // Two people in the same open/social zone hear each other clearly
  // regardless of exact in-zone distance (an open area isn't private, just
  // not distance-gated within itself).
  if (listenerZone?.kind === "open" && speakerZone?.kind === "open" && listenerZone.id === speakerZone.id) {
    return FULL_GAIN;
  }

  return raw;
}
