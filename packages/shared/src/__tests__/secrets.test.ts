import { describe, it, expect } from "vitest";
import { resolveSecret } from "../secrets";

const DEV = "dev-default-value";
const REAL = "a-real-secret-0123456789abcdef0123456789abcdef";

describe("resolveSecret", () => {
  describe("in production", () => {
    const prod = (extra: Record<string, string | undefined> = {}) => ({ NODE_ENV: "production", ...extra });

    it("returns a real value unchanged", () => {
      expect(resolveSecret(prod({ S: REAL }), "S", DEV)).toBe(REAL);
    });

    it("refuses a missing value", () => {
      expect(() => resolveSecret(prod(), "S", DEV)).toThrow(/S is missing or blank/);
    });

    it("refuses an empty or whitespace-only value", () => {
      expect(() => resolveSecret(prod({ S: "" }), "S", DEV)).toThrow(/missing or blank/);
      expect(() => resolveSecret(prod({ S: " \t " }), "S", DEV)).toThrow(/missing or blank/);
    });

    it("refuses the public development default, also when padded with spaces", () => {
      expect(() => resolveSecret(prod({ S: DEV }), "S", DEV)).toThrow(/public development default/);
      expect(() => resolveSecret(prod({ S: `  ${DEV}  ` }), "S", DEV)).toThrow(/public development default/);
    });

    it("never prints the value in the error", () => {
      let message = "";
      try {
        resolveSecret(prod({ S: DEV }), "S", DEV);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("S");
      expect(message).not.toContain(DEV);
    });

    it("uses a custom hint instead of the random-value advice when one is given", () => {
      let message = "";
      try {
        resolveSecret(prod(), "DATABASE_URL", DEV, "Set DATABASE_URL to your production database address.");
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("DATABASE_URL");
      expect(message).toContain("your production database address");
      expect(message).not.toContain("openssl");
    });

    it("does not treat a value that merely contains the default as the default", () => {
      expect(resolveSecret(prod({ S: `${DEV}-plus-more` }), "S", DEV)).toBe(`${DEV}-plus-more`);
    });
  });

  describe("outside production the behaviour is unchanged", () => {
    it.each([{ NODE_ENV: "development" }, { NODE_ENV: "test" }, {}])("falls back to the default for %j", (env) => {
      expect(resolveSecret(env, "S", DEV)).toBe(DEV);
    });

    it("uses a value that is set, including an empty one (as `??` always did)", () => {
      expect(resolveSecret({ NODE_ENV: "development", S: REAL }, "S", DEV)).toBe(REAL);
      expect(resolveSecret({ NODE_ENV: "development", S: "" }, "S", DEV)).toBe("");
    });
  });
});
