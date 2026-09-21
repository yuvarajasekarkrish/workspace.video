/**
 * Runs once when the server starts, and must finish before it takes requests.
 * Loading env.ts here makes the production settings checks (missing, blank or
 * public-default secrets) stop the server at start-up, not at the first request
 * that happens to import it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./lib/env");
  }
}
