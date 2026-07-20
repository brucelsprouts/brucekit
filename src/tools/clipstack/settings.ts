/**
 * ClipStack settings: the pure parsing/normalizing half, kept out of the panel
 * so it can be unit-tested. The persisted shape lives under `tools.clipstack`
 * in config.json and is read back by the Rust monitor (`clips_config_from_tools`),
 * so the two sides must agree on key names and normalization rules.
 */

/** `0` means unlimited. */
export const DEFAULT_MAX_HISTORY = 200;
/** Mirrors MAX_HISTORY_LIMIT in clips.rs. */
export const MAX_HISTORY_LIMIT = 10_000;
export const MIN_MAX_HISTORY = 10;

/**
 * Apps skipped out of the box, mirroring DEFAULT_EXCLUDED_APPS in clips.rs.
 * Password managers copy secrets meant to live only until the paste.
 */
export const DEFAULT_EXCLUDED_APPS = [
  "1password",
  "bitwarden",
  "keepass",
  "lastpass",
  "dashlane",
  "nordpass",
  "protonpass",
  "enpass",
];

export type ClipsSettings = {
  maxHistory: number;
  excludedApps: string[];
  honorSensitive: boolean;
};

/**
 * Clamp a user-typed history cap. `0` is passed through as "unlimited";
 * anything unparseable falls back to the default rather than to 0, since
 * silently switching to unlimited storage is the wrong way to fail.
 */
export function clampMaxHistory(raw: string | number): number {
  // `Number("")` is 0, so an empty field would otherwise read as "unlimited".
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  if (!text) return DEFAULT_MAX_HISTORY;
  const n = Number(text);
  if (!Number.isFinite(n)) return DEFAULT_MAX_HISTORY;
  const i = Math.trunc(n);
  if (i <= 0) return 0;
  return Math.min(Math.max(i, MIN_MAX_HISTORY), MAX_HISTORY_LIMIT);
}

/**
 * Turn the free-text exclusion editor into the stored list: one entry per
 * line or comma, trimmed, lowercased, de-duplicated, blanks dropped. Blanks
 * matter — an empty entry would substring-match every app and silently
 * disable capture altogether.
 */
export function parseExcludedApps(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[\n,]/)) {
    const entry = part.trim().toLowerCase();
    if (entry) seen.add(entry);
  }
  return [...seen];
}

/** Render the stored list back into the editor, one per line. */
export function formatExcludedApps(apps: string[]): string {
  return apps.join("\n");
}
