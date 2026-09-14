import { describe, it, expect } from "vitest";
import { shouldEmitObjectUpdate } from "../objectSync";

const rect = { x: 0, y: 0, width: 100, height: 100 };

describe("shouldEmitObjectUpdate", () => {
  it("emits immediately when there is no prior send", () => {
    expect(shouldEmitObjectUpdate(null, null, 1000, rect)).toBe(true);
  });

  it("does not emit when the rect is unchanged, regardless of elapsed time", () => {
    expect(shouldEmitObjectUpdate(0, rect, 10_000, rect)).toBe(false);
  });

  it("does not emit a changed rect before the throttle interval has elapsed", () => {
    const next = { ...rect, x: 5 };
    expect(shouldEmitObjectUpdate(1000, rect, 1010, next, 50)).toBe(false);
  });

  it("emits a changed rect once the throttle interval has elapsed", () => {
    const next = { ...rect, x: 5 };
    expect(shouldEmitObjectUpdate(1000, rect, 1050, next, 50)).toBe(true);
  });

  it("treats a width/height-only change as a change (resize, not just move)", () => {
    const next = { ...rect, width: 150 };
    expect(shouldEmitObjectUpdate(1000, rect, 1050, next, 50)).toBe(true);
  });
});
