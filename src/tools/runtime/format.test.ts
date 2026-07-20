import { describe, expect, it } from "vitest";
import { formatDuration, formatUptime } from "./format";

describe("formatUptime", () => {
  it("uses the two largest units that matter", () => {
    expect(formatUptime(45)).toBe("45s");
    expect(formatUptime(90)).toBe("1m");
    expect(formatUptime(8100)).toBe("2h 15m");
    expect(formatUptime(356_400)).toBe("4d 3h");
  });

  it("does not roll days up into hours", () => {
    // formatDuration's hours-only ceiling would render this as "99h 0m".
    expect(formatUptime(356_400)).not.toContain("99h");
  });

  it("rejects nonsense rather than rendering it", () => {
    expect(formatUptime(-1)).toBe("--");
    expect(formatUptime(Number.NaN)).toBe("--");
  });
});

describe("formatDuration", () => {
  it("picks the two most significant units", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(754_000)).toBe("12m 34s");
    expect(formatDuration(8_040_000)).toBe("2h 14m");
  });

  it("rejects garbage", () => {
    expect(formatDuration(-1)).toBe("--");
    expect(formatDuration(Number.NaN)).toBe("--");
  });
});
