import { describe, expect, it } from "vitest";
import {
  clampMaxHistory,
  formatExcludedApps,
  parseExcludedApps,
  DEFAULT_MAX_HISTORY,
  MAX_HISTORY_LIMIT,
  MIN_MAX_HISTORY,
} from "./settings";

describe("clampMaxHistory", () => {
  it("passes sane values through", () => {
    expect(clampMaxHistory("500")).toBe(500);
    expect(clampMaxHistory(500)).toBe(500);
  });

  it("treats zero and negatives as unlimited", () => {
    expect(clampMaxHistory("0")).toBe(0);
    expect(clampMaxHistory(-5)).toBe(0);
  });

  it("clamps to the supported range", () => {
    expect(clampMaxHistory("3")).toBe(MIN_MAX_HISTORY);
    expect(clampMaxHistory("999999")).toBe(MAX_HISTORY_LIMIT);
  });

  it("falls back to the default rather than to unlimited on junk", () => {
    // Failing open to unlimited storage would be the wrong way to fail.
    expect(clampMaxHistory("abc")).toBe(DEFAULT_MAX_HISTORY);
    expect(clampMaxHistory("")).toBe(DEFAULT_MAX_HISTORY);
    expect(clampMaxHistory(NaN)).toBe(DEFAULT_MAX_HISTORY);
  });

  it("truncates fractions", () => {
    expect(clampMaxHistory("250.9")).toBe(250);
  });
});

describe("parseExcludedApps", () => {
  it("splits on newlines and commas, trimming and lowercasing", () => {
    expect(parseExcludedApps("1Password\n  KeePassXC , Bitwarden ")).toEqual([
      "1password",
      "keepassxc",
      "bitwarden",
    ]);
  });

  it("drops blank entries", () => {
    // A blank entry would substring-match every app and disable capture.
    expect(parseExcludedApps("\n\n  ,, \n")).toEqual([]);
    expect(parseExcludedApps("vault\n\n,\nnotes")).toEqual(["vault", "notes"]);
  });

  it("de-duplicates case-insensitively", () => {
    expect(parseExcludedApps("Vault\nvault\nVAULT")).toEqual(["vault"]);
  });

  it("round-trips through the editor format", () => {
    const apps = ["1password", "keepass"];
    expect(parseExcludedApps(formatExcludedApps(apps))).toEqual(apps);
  });
});
