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
 * The error names the variable and never prints the value.
 */
export function resolveSecret(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
  devDefault: string,
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
        `Set ${name} to a private random value, for example: openssl rand -hex 32`,
    );
  }
  return raw as string;
}
