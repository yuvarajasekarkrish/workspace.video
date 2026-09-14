import { describe, it, expect } from "vitest";
import { validateObjectData, MAX_OBJECT_DATA_BYTES } from "../objectData";

describe("validateObjectData", () => {
  it("accepts an empty note (all fields default)", () => {
    expect(validateObjectData("note", {})).toEqual({ valid: true });
  });

  it("accepts a well-formed note", () => {
    expect(validateObjectData("note", { text: "hello", color: "pink" })).toEqual({ valid: true });
  });

  it("rejects a note with an unknown color", () => {
    const result = validateObjectData("note", { color: "chartreuse" });
    expect(result.valid).toBe(false);
  });

  it("rejects a note whose text exceeds the length cap", () => {
    const result = validateObjectData("note", { text: "x".repeat(4001) });
    expect(result.valid).toBe(false);
  });

  it("accepts an image with an https URL", () => {
    expect(validateObjectData("image", { url: "https://example.com/cat.png" })).toEqual({ valid: true });
  });

  it("rejects an image with an http URL", () => {
    const result = validateObjectData("image", { url: "http://example.com/cat.png" });
    expect(result.valid).toBe(false);
  });

  it("rejects an image with a javascript: URL", () => {
    const result = validateObjectData("image", { url: "javascript:alert(1)" });
    expect(result.valid).toBe(false);
  });

  it("rejects an image missing a url", () => {
    const result = validateObjectData("image", {});
    expect(result.valid).toBe(false);
  });

  it("accepts a well-formed link", () => {
    expect(
      validateObjectData("link", { url: "https://example.com", title: "Example" }),
    ).toEqual({ valid: true });
  });

  it("rejects a link with a data: URL", () => {
    const result = validateObjectData("link", { url: "data:text/html,<script>1</script>" });
    expect(result.valid).toBe(false);
  });

  it("accepts a shape with all fields defaulted", () => {
    expect(validateObjectData("shape", {})).toEqual({ valid: true });
  });

  it("rejects a shape with a non-hex fill color", () => {
    const result = validateObjectData("shape", { fill: "blue" });
    expect(result.valid).toBe(false);
  });

  it("rejects a shape with strokeWidth out of range", () => {
    const result = validateObjectData("shape", { strokeWidth: 999 });
    expect(result.valid).toBe(false);
  });

  it("accepts a zone with all fields defaulted", () => {
    expect(validateObjectData("zone", {})).toEqual({ valid: true });
  });

  it("accepts an embed with arbitrary small data (not implemented, but not crashing)", () => {
    expect(validateObjectData("embed", { anything: "goes" })).toEqual({ valid: true });
  });

  it("rejects data exceeding the overall byte cap regardless of type", () => {
    const result = validateObjectData("note", { text: "x".repeat(MAX_OBJECT_DATA_BYTES) });
    expect(result.valid).toBe(false);
  });

  it("rejects unserializable data", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = validateObjectData("note", circular);
    expect(result.valid).toBe(false);
  });
});
