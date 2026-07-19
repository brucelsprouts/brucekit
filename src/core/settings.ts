import { LazyStore } from "@tauri-apps/plugin-store";

/**
 * Per-tool settings, automatically namespaced by tool id so one tool can never
 * read or clobber another's config (spec §4 contract invariant).
 *
 * The persisted shape mirrors config.json (§8):
 *   { "tools": { "<id>": { "<key>": <value> } } }
 */

export const CONFIG_FILE = "config.json";
const TOOLS_KEY = "tools";

export type ToolsBag = Record<string, Record<string, unknown>>;

/** Pure read of a namespaced value with fallback (unit-tested). */
export function getToolValue<T>(
  bag: ToolsBag | undefined | null,
  id: string,
  key: string,
  fallback: T,
): T {
  const ns = bag?.[id];
  if (ns && Object.prototype.hasOwnProperty.call(ns, key)) {
    return ns[key] as T;
  }
  return fallback;
}

/**
 * Pure write returning a NEW bag with only `id`'s namespace touched — proves
 * isolation: sibling namespaces are copied through untouched (unit-tested).
 */
export function setToolValue<T>(
  bag: ToolsBag | undefined | null,
  id: string,
  key: string,
  value: T,
): ToolsBag {
  const base: ToolsBag = { ...(bag ?? {}) };
  base[id] = { ...(base[id] ?? {}), [key]: value };
  return base;
}

/** The async, store-backed interface handed to each tool via `ToolContext`. */
export type ToolSettings = {
  get<T>(key: string, fallback: T): Promise<T>;
  set<T>(key: string, value: T): Promise<void>;
};

// Single lazily-loaded store shared with the Rust side (same config.json file).
const store = new LazyStore(CONFIG_FILE);

async function readBag(): Promise<ToolsBag> {
  return (await store.get<ToolsBag>(TOOLS_KEY)) ?? {};
}

/** Build the namespaced settings handle for one tool id. */
export function makeToolSettings(id: string): ToolSettings {
  return {
    async get<T>(key: string, fallback: T): Promise<T> {
      return getToolValue(await readBag(), id, key, fallback);
    },
    async set<T>(key: string, value: T): Promise<void> {
      const next = setToolValue(await readBag(), id, key, value);
      await store.set(TOOLS_KEY, next);
      await store.save();
    },
  };
}
