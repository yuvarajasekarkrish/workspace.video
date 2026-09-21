import { describe, it, expect } from "vitest";
import { describeLinkError } from "../auth/linkError";

describe("describeLinkError (what to tell someone whose sign-in link did not work)", () => {
  it("explains a link that was used or has expired, and says what to do", () => {
    for (const code of ["INVALID_TOKEN", "EXPIRED_TOKEN"]) {
      const message = describeLinkError(code);
      expect(message, code).toMatch(/expired or was already used/i);
      expect(message, code).toMatch(/new one/i);
    }
  });

  it("gives a plain message for any other error code, without showing the code", () => {
    const message = describeLinkError("SOMETHING_ELSE");
    expect(message).toMatch(/didn't work/i);
    expect(message).not.toContain("SOMETHING_ELSE");
  });

  it("says nothing when there is no error", () => {
    expect(describeLinkError(undefined)).toBeUndefined();
    expect(describeLinkError("")).toBeUndefined();
    expect(describeLinkError(["A", "B"] as unknown as string)).toBeUndefined();
  });
});
