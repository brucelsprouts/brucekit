import { describe, expect, it } from "vitest";
import { formatRelative } from "./time";

const NOW = 1_700_000_000_000;

describe("formatRelative", () => {
  it("treats fresh timestamps (and clock skew) as just now", () => {
    expect(formatRelative(NOW, NOW)).toBe("just now");
    expect(formatRelative(NOW - 4_000, NOW)).toBe("just now");
    expect(formatRelative(NOW + 60_000, NOW)).toBe("just now"); // future ts never goes negative
  });

  it("steps through seconds, minutes, hours, days", () => {
    expect(formatRelative(NOW - 30_000, NOW)).toBe("30s ago");
    expect(formatRelative(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(formatRelative(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(formatRelative(NOW - 9 * 86_400_000, NOW)).toBe("9d ago");
  });

  it("uses the floor of each unit", () => {
    expect(formatRelative(NOW - 119_000, NOW)).toBe("1m ago");
    expect(formatRelative(NOW - (24 * 3_600_000 - 1), NOW)).toBe("23h ago");
  });
});
