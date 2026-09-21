// A tiny static file server for the measurement page: serves the repository folder on http://127.0.0.1:8123.
// Local only (127.0.0.1). Stop it with Ctrl+C. Usage:  node docs/spikes/map-perf/serve.mjs
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = normalize(join(fileURLToPath(import.meta.url), "..", "..", "..", ".."));
const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".map": "application/json" };

createServer(async (req, res) => {
  const path = normalize(join(root, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!path.startsWith(root)) { res.writeHead(403).end("no"); return; }
  try {
    const body = await readFile(path);
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(8123, "127.0.0.1", () => console.log("serving " + root + " on http://127.0.0.1:8123"));
