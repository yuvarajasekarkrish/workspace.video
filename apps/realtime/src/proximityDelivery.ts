/** Validity check for a load run with proximity batching: the updates clients
 *  received must match the updates the server decided to send in the same
 *  window, whatever the framing. This is not a success metric; a run that fails
 *  it says nothing about the burst, because updates were lost or invented.
 *  Tolerance covers updates in flight at the two window edges. */
export function checkProximityDelivery(input: {
  serverUpdates: number;
  clientUpdates: number;
  tolerancePct?: number;
  floor?: number;
}): { ok: boolean; ratio: number | null; difference: number } {
  const tolerancePct = input.tolerancePct ?? 2;
  const floor = input.floor ?? 50;
  const difference = input.clientUpdates - input.serverUpdates;
  const allowed = Math.max(floor, (input.serverUpdates * tolerancePct) / 100);
  return {
    ok: Math.abs(difference) <= allowed,
    ratio: input.serverUpdates > 0 ? input.clientUpdates / input.serverUpdates : null,
    difference,
  };
}
