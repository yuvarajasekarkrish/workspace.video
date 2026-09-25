import { describe, it, expect } from "vitest";

// Architectural independence check, ported from the retired openOffice.test.ts
// (openOffice@1 was removed once office300@1 became the sole default — see
// registry.ts). Not specific to any one layout file: scans every real layout
// module in this directory, so it keeps applying no matter which layouts
// exist in the future.
describe("layout files: architectural independence", () => {
  it("no layout module depends on plans.ts or re-imports the package's own public barrel", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "..");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes("__tests__"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const contents = fs.readFileSync(path.join(dir, file), "utf-8");
      expect(contents, file).not.toMatch(/from ["'].*plans["']/);
      expect(contents, file).not.toMatch(/from ["']@workspace-video\/shared["']/);
    }
  });
});
