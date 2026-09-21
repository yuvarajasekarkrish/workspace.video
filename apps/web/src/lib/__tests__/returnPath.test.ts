import { describe, it, expect } from "vitest";
import { safeReturnPath, returnPathForRoom, signInAddressFor } from "../returnPath";

describe("safeReturnPath (where to send someone after they sign in)", () => {
  it("accepts a page on this site", () => {
    expect(safeReturnPath("/room/abc123")).toBe("/room/abc123");
    expect(safeReturnPath("/workspaces/new")).toBe("/workspaces/new");
  });

  it("keeps a query string", () => {
    expect(safeReturnPath("/room/abc?x=1")).toBe("/room/abc?x=1");
  });

  it("refuses anything that could leave the site", () => {
    for (const bad of [
      "https://evil.example/room/1",
      "//evil.example/room/1",
      "/\\evil.example",
      "\\\\evil.example",
      "javascript:alert(1)",
      "room/1",
      "",
      "/room/1\nSet-Cookie: x=1",
      "/room/1\u0000",
    ]) {
      expect(safeReturnPath(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("refuses the API and sign-in plumbing as a destination", () => {
    expect(safeReturnPath("/api/auth/sign-out")).toBeNull();
  });

  it("refuses non-text and very long values", () => {
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath(["/room/1"] as unknown as string)).toBeNull();
    expect(safeReturnPath("/" + "a".repeat(600))).toBeNull();
  });
});

describe("returnPathForRoom / signInAddressFor", () => {
  it("builds the room address and the sign-in address that remembers it", () => {
    expect(returnPathForRoom("abc123")).toBe("/room/abc123");
    expect(signInAddressFor("/room/abc123")).toBe("/?next=%2Froom%2Fabc123");
  });

  it("round-trips through the rule that reads it back", () => {
    const url = new URL(signInAddressFor("/room/abc?x=1&y=2"), "https://app.example");
    expect(safeReturnPath(url.searchParams.get("next"))).toBe("/room/abc?x=1&y=2");
  });
});
