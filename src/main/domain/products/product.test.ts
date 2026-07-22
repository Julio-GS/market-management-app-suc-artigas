// ---------------------------------------------------------------------------
// Domain: Product pure helpers — unit tests
//
// Tests sanitizeProductCodes independently of any database or framework.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { sanitizeProductCodes } from "./product";

describe("sanitizeProductCodes", () => {
  it("returns an empty array when input is null", () => {
    expect(sanitizeProductCodes(null)).toEqual([]);
  });

  it("returns an empty array when input is undefined", () => {
    expect(sanitizeProductCodes(undefined)).toEqual([]);
  });

  it("returns an empty array when input is not an array", () => {
    expect(sanitizeProductCodes("not-an-array" as unknown as string[])).toEqual([]);
  });

  it("returns an empty array when the array is empty", () => {
    expect(sanitizeProductCodes([])).toEqual([]);
  });

  it("trims whitespace from each code", () => {
    expect(sanitizeProductCodes(["  ABC  ", "  DEF"])).toEqual(["ABC", "DEF"]);
  });

  it("skips empty strings after trimming", () => {
    expect(sanitizeProductCodes(["ABC", "   ", "DEF"])).toEqual(["ABC", "DEF"]);
  });

  it("deduplicates by trimmed value, keeping first occurrence", () => {
    expect(sanitizeProductCodes(["ABC", "abc", "  ABC  "])).toEqual(["ABC", "abc"]);
  });

  it("skips non-string elements", () => {
    expect(sanitizeProductCodes(["ABC", 123 as unknown as string, "DEF"])).toEqual(["ABC", "DEF"]);
  });

  it("preserves order of first occurrence", () => {
    expect(sanitizeProductCodes(["Z", "A", "Z", "B"])).toEqual(["Z", "A", "B"]);
  });

  it("handles codes with only whitespace", () => {
    expect(sanitizeProductCodes(["   ", "  "])).toEqual([]);
  });
});
