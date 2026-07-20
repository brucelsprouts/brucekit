import { useCallback, useEffect, useRef } from "react";

/**
 * One-slot undo for the destructive actions in the panels: clearing an OCR
 * scan, deleting a clip, wiping the clip history. Not a history stack — the
 * point is a short grace period after a click you didn't mean, not a general
 * undo tree, and a stack of half-valid entries pointing at unmounted panels
 * would be worse than nothing.
 *
 * Two rules keep a stale ctrl+z from firing into a panel that has moved on:
 * entries expire after `UNDO_TTL_MS`, and the panel that registered one drops
 * it on unmount (see `useUndoSlot`).
 */

const UNDO_TTL_MS = 30_000;

export type UndoEntry = {
  /** Names the thing that comes back, e.g. "the scan" → "Restored the scan". */
  label: string;
  run: () => void | Promise<void>;
};

type Pending = UndoEntry & { token: number; expiresAt: number };

export type UndoSlot = {
  /** Registers an undo, replacing any pending one. Returns its ownership token. */
  push: (label: string, run: () => void | Promise<void>) => number;
  /** Takes the pending entry if it hasn't expired, clearing the slot. */
  take: () => UndoEntry | null;
  /** Withdraws the entry, but only if `token` still owns the slot. */
  clear: (token: number) => void;
  /** Label of the live entry, or null. */
  peek: () => string | null;
};

export function createUndoSlot({
  ttlMs = UNDO_TTL_MS,
  now = () => Date.now(),
}: { ttlMs?: number; now?: () => number } = {}): UndoSlot {
  let pending: Pending | null = null;
  let nextToken = 1;

  /** Reads the slot, dropping the entry if its window has closed. */
  const live = (): Pending | null => {
    if (pending && now() > pending.expiresAt) pending = null;
    return pending;
  };

  return {
    push(label, run) {
      const token = nextToken++;
      pending = { label, run, token, expiresAt: now() + ttlMs };
      return token;
    },
    take() {
      const entry = live();
      if (!entry) return null;
      pending = null;
      return { label: entry.label, run: entry.run };
    },
    clear(token) {
      if (pending?.token === token) pending = null;
    },
    peek() {
      return live()?.label ?? null;
    },
  };
}

/** The app-wide slot. Panels push to it; the launcher takes from it. */
export const undoSlot = createUndoSlot();

/**
 * Panel-side handle on the undo slot. The returned function registers an undo;
 * whatever it registered is withdrawn when the panel unmounts, so backing out
 * of a module retires its undo along with the state it would have restored.
 */
export function useUndoSlot(): (label: string, run: () => void | Promise<void>) => void {
  const token = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (token.current !== null) undoSlot.clear(token.current);
    },
    [],
  );

  return useCallback((label, run) => {
    token.current = undoSlot.push(label, run);
  }, []);
}

export function isUndoHotkey(e: KeyboardEvent): boolean {
  // Shift+ctrl+z is redo by convention everywhere else; leave it alone rather
  // than quietly treating it as another undo.
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "z";
}

/** Input types that hold text the browser can undo on its own. */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "password",
  "number",
]);

/**
 * True when the browser's own undo should win — the hex field, the clip search
 * box. A read-only box has no edits to undo, so it doesn't count: ctrl+z with
 * the OCR result focused should bring back a cleared scan.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // Matched by attribute rather than `isContentEditable` so an editable
  // ancestor counts too — and because jsdom does not implement the property.
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  if (target instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(target.type) && !target.readOnly && !target.disabled;
  }
  return false;
}
