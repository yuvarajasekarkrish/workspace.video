/** Development fallback for REALTIME_JWT_SECRET. Exported so the web app (which
 *  signs socket tokens) and the realtime server (which verifies them) can never
 *  disagree about it. It is public, so production refuses it (see resolveSecret). */
export const DEV_REALTIME_JWT_SECRET = "dev-only-insecure-realtime-secret-change-me";

/** Development fallback for DATABASE_URL (the local docker-compose database). It
 *  contains a password that is written in the repository, so production refuses it. */
export const DEV_DATABASE_URL = "postgresql://workspace:workspace@localhost:5432/workspace_video";

/**
 * Resolves a secret from the environment.
 *
 * Outside production this behaves exactly like `source[name] ?? devDefault`, so a
 * fresh checkout runs with no setup. In production (NODE_ENV === "production") a
 * missing, blank or public-default value is refused loudly, because the default
 * is written in the repository and anyone could use it to forge sign-in tokens.
 *
 * `source` is passed in (callers pass `process.env`) so this package needs no
 * Node types and the function can be tested without touching the real environment.
 * The error names the variable and never prints the value. `hint` replaces the
 * default "private random value" advice for values that are not random secrets.
 */
export function resolveSecret(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
  devDefault: string,
  hint?: string,
): string {
  const raw = source[name];
  if (source.NODE_ENV !== "production") {
    return raw ?? devDefault;
  }

  const value = raw?.trim();
  if (!value || value === devDefault) {
    const problem = !value ? "is missing or blank" : "is the public development default";
    throw new Error(
      `Refusing to start in production: ${name} ${problem}. ` +
        (hint ?? `Set ${name} to a private random value, for example: openssl rand -hex 32`),
    );
  }
  return raw as string;
}

/** DATABASE_URL: the local development database outside production, and in
 *  production an explicit address whose password is not the public default. */
export function resolveDatabaseUrl(source: Readonly<Record<string, string | undefined>>): string {
  return resolveSecret(
    source,
    "DATABASE_URL",
    DEV_DATABASE_URL,
    "Set DATABASE_URL to your production database address, with its own password.",
  );
}
