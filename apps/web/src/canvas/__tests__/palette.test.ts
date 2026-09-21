import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ACCENT, GROUND, GROUND_CSS, cssHex } from "../palette";

// Every colour the room canvas draws with lives in canvas/palette.ts. Before this, the same amber was copied into
// four files, so changing the accent (or bringing the room onto DESIGN.md's colours) meant hunting for copies and
// missing one. A colour written anywhere else in the canvas code fails this test.

// Tests run from apps/web (the package root), where the canvas folder is src/canvas.
const CANVAS_DIR = resolve(process.cwd(), "src", "canvas");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "__tests__" || name === "node_modules") return [];
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return name.endsWith(".ts") && name !== "palette.ts" ? [path] : [];
  });
}

describe("the canvas palette", () => {
  it("turns a colour number into the CSS text Pixi and the page need", () => {
    expect(cssHex(0xf5a623)).toBe("#f5a623");
    expect(cssHex(0x0a0a0a)).toBe("#0a0a0a");
    expect(cssHex(0x000000)).toBe("#000000");
    expect(GROUND_CSS).toBe(cssHex(GROUND));
  });

  it("keeps the accent and the ground the room had before the colours moved here", () => {
    expect(ACCENT).toBe(0xf5a623);
    expect(GROUND).toBe(0x0a0a0a);
  });

  it("is the only canvas file that writes a colour", () => {
    const files = sourceFiles(CANVAS_DIR);
    expect(files.length, "the test must actually find the canvas source files").toBeGreaterThan(8);
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const found = text.match(/0x[0-9a-fA-F]{6}\b|["'`]#[0-9a-fA-F]{3,8}["'`]/g);
      if (found) offenders.push(`${file.slice(CANVAS_DIR.length)}: ${[...new Set(found)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
