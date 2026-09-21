import { describe, it, expect } from "vitest";
import { optionalHttpsUrl, optionalEmail, socialLinksFrom } from "../publicLinks";

describe("optionalHttpsUrl (an address the owner may configure for a public link)", () => {
  it("accepts an https address", () => {
    expect(optionalHttpsUrl("https://cal.com/team/demo")).toBe("https://cal.com/team/demo");
  });

  it("returns nothing when it is not set, blank, or not https", () => {
    for (const v of [undefined, "", "   ", "http://cal.com/x", "javascript:alert(1)", "ftp://x.example", "cal.com/x", "https://"]) {
      expect(optionalHttpsUrl(v), String(v)).toBeUndefined();
    }
  });

  it("trims surrounding spaces", () => {
    expect(optionalHttpsUrl("  https://cal.com/x  ")).toBe("https://cal.com/x");
  });
});

describe("optionalEmail", () => {
  it("accepts a plain address and refuses anything else", () => {
    expect(optionalEmail("hello@workspace.video")).toBe("hello@workspace.video");
    for (const v of [undefined, "", "not an email", "a@b", "x@y.com?subject=hi", "a b@c.com"]) {
      expect(optionalEmail(v), String(v)).toBeUndefined();
    }
  });
});

describe("socialLinksFrom", () => {
  it("lists only the accounts that are configured with a valid https address, in a fixed order", () => {
    const links = socialLinksFrom({
      SOCIAL_LINKEDIN_URL: "https://www.linkedin.com/company/x",
      SOCIAL_X_URL: "http://insecure.example",
      SOCIAL_INSTAGRAM_URL: "https://www.instagram.com/x",
    });
    expect(links).toEqual([
      { label: "Instagram", href: "https://www.instagram.com/x" },
      { label: "LinkedIn", href: "https://www.linkedin.com/company/x" },
    ]);
  });

  it("is empty when nothing is configured", () => {
    expect(socialLinksFrom({})).toEqual([]);
  });
});
