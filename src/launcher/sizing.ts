import type { WindowSize } from "../core/ipc";
import type { ToolModule } from "../tools/types";

export type { WindowSize };

/**
 * Launcher window sizing for the *panel* views (spec §3, §6).
 *
 * The module grid is not sized from here — it measures its own content, which
 * moves with the pin count. Everything else (a module panel, the settings view)
 * gets a size resolved by `resolvePanelSize` and remembered under its own view
 * id, so sizing one panel never re-sizes another.
 */

/** The view id of the settings screen, alongside the module ids. */
export const SETTINGS_VIEW = "settings";

/** Settings' opening size: a scrolling list of module rows, so height-led. */
export const SETTINGS_SIZE: WindowSize = { width: 640, height: 560 };

/**
 * Last-resort size, for a panel that declares no `panelSize` and has never been
 * dragged in a config that predates per-view sizes.
 */
export const DEFAULT_PANEL_SIZE: WindowSize = { width: 720, height: 520 };

/**
 * The view currently on screen: a module id, `"settings"`, or `null` for the
 * module grid. `null` is what tells the resize listener there is nothing worth
 * persisting — the grid's size is computed, never chosen.
 */
export type ViewKey = string | null;

/** Which view a launcher state is showing. Settings wins, mirroring render order. */
export function viewKeyFor(settingsOpen: boolean, activeTool: ToolModule | null): ViewKey {
  if (settingsOpen) return SETTINGS_VIEW;
  return activeTool?.id ?? null;
}

/** The size a view declares for itself before the user has ever dragged it. */
export function declaredSize(view: ViewKey, activeTool: ToolModule | null): WindowSize | undefined {
  if (view === SETTINGS_VIEW) return SETTINGS_SIZE;
  return activeTool?.panelSize;
}

/**
 * The size to open `view` at, most specific source first:
 *
 * 1. what the user last dragged *this* view to,
 * 2. what the module declares as its own default,
 * 3. the legacy single panel size, so an existing install doesn't lose the one
 *    size it had the moment sizes went per-view,
 * 4. a neutral default.
 *
 * Non-finite or non-positive numbers from any source are treated as absent — a
 * half-written config entry should fall through to the next source rather than
 * clamp the window to its minimum.
 */
export function resolvePanelSize(
  view: string,
  stored: Record<string, WindowSize>,
  declared: WindowSize | undefined,
  legacy: WindowSize | null,
): WindowSize {
  for (const candidate of [stored[view], declared, legacy]) {
    if (isUsable(candidate)) return { width: candidate.width, height: candidate.height };
  }
  return DEFAULT_PANEL_SIZE;
}

function isUsable(size: WindowSize | null | undefined): size is WindowSize {
  return (
    !!size &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/**
 * Whether a reported window size is the one we just asked for.
 *
 * Opening a panel resizes the window, and the OS reports that resize back
 * through the same listener a user drag arrives on. Without this the launcher
 * would persist its own programmatic size as though the user had chosen it —
 * harmless when it agrees with what's stored, but it also means every view
 * switch writes to disk. Compared with a 1px tolerance because the round trip
 * through physical pixels and back is lossy at fractional DPI scaling.
 */
export function isEchoOfCommand(reported: WindowSize, commanded: WindowSize | null): boolean {
  if (!commanded) return false;
  return (
    Math.abs(reported.width - commanded.width) <= 1 &&
    Math.abs(reported.height - commanded.height) <= 1
  );
}
