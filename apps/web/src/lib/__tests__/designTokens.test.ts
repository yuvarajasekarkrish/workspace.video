// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

// The colours live once, as CSS variables in globals.css (see DESIGN.md at the repo
// root). This guards the accessibility rule that came out of the design review:
// text needs 4.5:1 against the surface it sits on, and interface parts 3:1.

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../app/globals.css"), "utf8");

function token(name: string): string {
  const match = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
  if (!match) throw new Error(`--color-${name} is not defined in globals.css`);
  return match[1]!;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("design tokens: text contrast (needs 4.5:1)", () => {
  const surfaces = ["ground", "surface"] as const;
  const texts = ["fg", "fg-muted", "link", "danger"] as const;

  for (const surface of surfaces) {
    for (const text of texts) {
      it(`${text} on ${surface}`, () => {
        expect(contrast(token(text), token(surface))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it("the label on the accent button", () => {
    expect(contrast(token("on-accent"), token("accent"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("design tokens: interface parts (need 3:1)", () => {
  it("the keyboard focus ring is visible on the page and on inputs", () => {
    expect(contrast(token("focus"), token("ground"))).toBeGreaterThanOrEqual(3);
    expect(contrast(token("focus"), token("surface"))).toBeGreaterThanOrEqual(3);
  });
});

describe("globals.css: browser surfaces belong to the design", () => {
  it("themes the focus ring, selection and caret, and sets the body font from a token", () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline/);
    expect(css).toMatch(/::selection/);
    expect(css).toMatch(/caret-color/);
    expect(css).toMatch(/font-family:\s*var\(--font-sans\)/);
  });
});

// The design review (docs/architecture/company-map-builder.md, D17) replaced amber with one soft teal as the accent.
describe("the accent colour", () => {
  it("is the soft teal chosen in the design review, with a darker teal for hover and a lighter teal for links", () => {
    expect(token("accent").toLowerCase()).toBe("#2dd4bf");
    expect(token("accent-hover").toLowerCase()).toBe("#14b8a6");
    expect(token("link").toLowerCase()).toBe("#5eead4");
  });

  it("leaves no amber colour value anywhere in the web app (status dots use Tailwind class names, not values, and are decided separately)", () => {
    const srcDir = join(dirname(fileURLToPath(import.meta.url)), "../..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === "__tests__" || name === "node_modules") continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx|css|svg)$/.test(name)) files.push(path);
      }
    };
    walk(srcDir);
    expect(files.length, "the test must actually find the source files").toBeGreaterThan(30);
    const amber = /#f5a623|#f2b35a|#f2c27e|#e09612|0xf5a623|rgba?\(\s*245\s*,\s*166\s*,\s*35/i;
    const offenders = files.filter((f) => amber.test(readFileSync(f, "utf8"))).map((f) => f.slice(srcDir.length));
    expect(offenders).toEqual([]);
  });
});
