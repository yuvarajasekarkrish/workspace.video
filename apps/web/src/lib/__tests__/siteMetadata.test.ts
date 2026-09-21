import { describe, it, expect } from "vitest";
import { siteMetadata } from "../siteMetadata";

describe("siteMetadata (the browser tab and the shared-link preview)", () => {
  it("names the product and says what it is, in plain words", () => {
    expect(String(siteMetadata.title)).toMatch(/workspace\.video/i);
    expect(String(siteMetadata.description)).toMatch(/virtual office/i);
  });

  it("has no development wording and no em dashes", () => {
    const text = JSON.stringify(siteMetadata);
    expect(text).not.toMatch(/milestone|todo|lorem/i);
    expect(text).not.toMatch(/[—–]/);
  });

  it("gives link previews the same title and description", () => {
    const og = siteMetadata.openGraph as { title?: string; description?: string; siteName?: string } | undefined;
    expect(og?.title).toBe(String(siteMetadata.title));
    expect(og?.description).toBe(String(siteMetadata.description));
    expect(og?.siteName).toBe("workspace.video");
  });
});
