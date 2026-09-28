import { describe, expect, it } from "vitest";
import { shouldStopSkipAtLine } from "../src/skip-policy.js";

describe("read-aware skip policy", () => {
  it("keeps skipping lines that are already read", () => {
    expect(shouldStopSkipAtLine(true, true)).toBe(false);
  });

  it("stops before the first unread line", () => {
    expect(shouldStopSkipAtLine(true, false)).toBe(true);
  });

  it("stops on an untrackable legacy/custom line rather than skipping blindly", () => {
    expect(shouldStopSkipAtLine(true, null)).toBe(true);
  });

  it("does nothing when skip is already off", () => {
    expect(shouldStopSkipAtLine(false, true)).toBe(false);
    expect(shouldStopSkipAtLine(false, false)).toBe(false);
    expect(shouldStopSkipAtLine(false, null)).toBe(false);
  });
});
