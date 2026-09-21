// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

// The live room follows DESIGN.md strictly (the owner's rule): text is at least 16 px, colours come from the design
// tokens (bg-surface, text-fg, border-line, text-accent and so on), and nothing uses blur, which costs battery.
// The room's overlay panels are React components with class names, so this reads their source.

const COMPONENTS = resolve(process.cwd(), "src", "components");

const OVERLAYS = [
  "ConnectionBadge",
  "OccupancyBadge",
  "RoomHud",
  "ZoneHudChip",
  "ZoneToast",
  "ObjectToolbar",
  "CapacityScreen",
  "RoomDock",
  "ZoomControls",
  "RoomCanvas",
];

const RULES: { name: string; pattern: RegExp }[] = [
  { name: "text smaller than 16 px (text-xs, text-sm)", pattern: /\btext-(xs|sm)\b/ },
  { name: "blur (backdrop-blur), which costs battery", pattern: /backdrop-blur/ },
  { name: "a raw black background instead of a token (bg-black)", pattern: /\bbg-black\b/ },
  { name: "a raw grey palette colour instead of a token (neutral-, slate-, gray-)", pattern: /\b(?:bg|text|border|placeholder)-(?:neutral|slate|gray|zinc)-\d/ },
];

describe("the room's overlay panels follow DESIGN.md", () => {
  for (const name of OVERLAYS) {
    const source = readFileSync(join(COMPONENTS, `${name}.tsx`), "utf8");
    for (const { name: rule, pattern } of RULES) {
      it(`${name} has no ${rule}`, () => {
        expect(source.match(pattern)?.[0] ?? null).toBeNull();
      });
    }
  }
});

describe("the room screen on a phone", () => {
  it("keeps the top-right stack (add a note, shape, zone or image, and the people list) for tablet width and up, so it never covers the area chip", () => {
    const canvas = readFileSync(join(COMPONENTS, "RoomCanvas.tsx"), "utf8");
    const stack = canvas.match(/<div className="([^"]*)">\s*<ObjectToolbar/);
    expect(stack, "the wrapper around the object toolbar").not.toBeNull();
    expect(stack![1]).toContain("hidden");
    expect(stack![1]).toContain("sm:flex");
  });
});
