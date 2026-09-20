/**
 * Offline analysis of a load-harness result JSON: prints the same emit-tail,
 * GC and stall-overlap report the harness prints at the end of a run, from the
 * file on disk. Read-only, no server needed.
 *
 *   pnpm --filter @workspace-video/realtime run analyze-stalls -- load-results/phase17-100-spread.json
 */
import { readFileSync } from "node:fs";
import { formatStallReport } from "../stallReport";

const path = process.argv[2];
if (!path) {
  console.error("usage: analyze-stalls <result.json>");
  process.exit(2);
}

const result = JSON.parse(readFileSync(path, "utf8")) as {
  serverMoveValidation?: { windows?: Parameters<typeof formatStallReport>[0]["windows"] } | null;
  serverEmitTail?: Parameters<typeof formatStallReport>[0]["emitTail"];
  serverGc?: Parameters<typeof formatStallReport>[0]["gc"];
};

const lines = formatStallReport({
  windows: result.serverMoveValidation?.windows ?? [],
  emitTail: result.serverEmitTail,
  gc: result.serverGc,
});
if (lines.length === 0) {
  console.error("No Phase 17 diagnostics in this file (a run made before commit B has none).");
  process.exit(1);
}
for (const line of lines) console.log(line);
