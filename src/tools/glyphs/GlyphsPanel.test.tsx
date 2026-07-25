import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types";

const writeText = vi.fn((_text: string) => Promise.resolve());
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (text: string) => writeText(text),
}));

// Imported after the mock so the panel picks it up.
const { GlyphsPanel } = await import("./GlyphsPanel");

const toast = vi.fn();
const set = vi.fn(() => Promise.resolve());

function makeCtx(stored: Record<string, unknown> = {}): ToolContext {
  return {
    invoke: vi.fn() as unknown as ToolContext["invoke"],
    toast,
    closeLauncher: vi.fn(),
    settings: {
      get: vi.fn((key: string, fallback: unknown) => Promise.resolve(stored[key] ?? fallback)),
      set,
    } as unknown as ToolContext["settings"],
  };
}

/** Render and wait for the stored-settings read to settle. */
async function show(stored: Record<string, unknown> = {}) {
  const ctx = makeCtx(stored);
  const view = render(<GlyphsPanel ctx={ctx} />);
  await waitFor(() => expect(ctx.settings.get).toHaveBeenCalled());
  return { ...view, ctx };
}

const search = () => screen.getByLabelText("Search characters");
/** Grid cells only — the pinned rail is also made of options. */
const cells = () => within(screen.getByLabelText("Characters")).getAllByRole("option");
const selectedCell = () => cells().find((c) => c.getAttribute("data-selected") === "true");

// jsdom has no layout, so it ships no scrollIntoView. The panel calls it to
// follow the highlight; stub it rather than guarding the component for a
// browser API every real target has.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GlyphsPanel", () => {
  it("opens on the letters category with a full grid", async () => {
    await show();
    expect(cells().length).toBeGreaterThan(100);
    expect(screen.getByRole("tab", { name: "LETTERS" })).toHaveAttribute("aria-selected", "true");
  });

  it("filters as you type and reports the count", async () => {
    await show();
    const before = cells().length;
    fireEvent.change(search(), { target: { value: "euro sign" } });
    expect(cells().length).toBeLessThan(before);
    expect(screen.getByLabelText("EURO SIGN")).toBeInTheDocument();
  });

  it("names the selection without the codepoint", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "euro sign" } });
    expect(screen.getByText("EURO SIGN")).toBeInTheDocument();
    expect(screen.queryByText("U+20AC")).not.toBeInTheDocument();
  });

  it("moves the selection with arrow keys", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "arrow" } });
    const first = selectedCell();
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    expect(selectedCell()).not.toBe(first);
    fireEvent.keyDown(search(), { key: "ArrowLeft" });
    expect(selectedCell()).toBe(first);
  });

  it("does not walk the selection off either end", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "euro sign" } });
    fireEvent.keyDown(search(), { key: "ArrowLeft" });
    expect(selectedCell()).toBe(cells()[0]);
    fireEvent.keyDown(search(), { key: "End" });
    fireEvent.keyDown(search(), { key: "ArrowRight" });
    expect(selectedCell()).toBe(cells()[cells().length - 1]);
  });

  it("copies the selection on Enter and says so", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "euro sign" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("€"));
    expect(toast).toHaveBeenCalledWith("Copied € · EURO SIGN", { kind: "success" });
  });

  it("copies on click and remembers it", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "em dash" } });
    fireEvent.click(screen.getByLabelText("EM DASH"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("—"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("recent", ["—"]));
  });

  it("surfaces a clipboard failure as an error toast", async () => {
    writeText.mockRejectedValueOnce(new Error("clipboard busy"));
    await show();
    fireEvent.change(search(), { target: { value: "euro sign" } });
    fireEvent.keyDown(search(), { key: "Enter" });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("clipboard busy", { kind: "error" }));
  });

  it("switches category on click and clears the query", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "euro" } });
    fireEvent.click(screen.getByRole("tab", { name: "GREEK" }));
    expect(search()).toHaveValue("");
    expect(screen.getByLabelText("GREEK SMALL LETTER PI")).toBeInTheDocument();
    expect(set).toHaveBeenCalledWith("category", "greek");
  });

  it("cycles categories with Tab", async () => {
    await show();
    fireEvent.keyDown(search(), { key: "Tab" });
    expect(screen.getByRole("tab", { name: "PUNCT" })).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(search(), { key: "Tab", shiftKey: true });
    expect(screen.getByRole("tab", { name: "LETTERS" })).toHaveAttribute("aria-selected", "true");
  });

  it("offers a RECENT chip only once there is history", async () => {
    const { unmount } = await show();
    expect(screen.queryByRole("tab", { name: "RECENT" })).not.toBeInTheDocument();
    unmount();

    await show({ recent: ["€", "—"] });
    fireEvent.click(screen.getByRole("tab", { name: "RECENT" }));
    expect(cells()).toHaveLength(2);
    expect(screen.getByLabelText("EURO SIGN")).toBeInTheDocument();
  });

  it("falls back when the stored category no longer exists", async () => {
    await show({ category: "retired-category" });
    expect(screen.getByRole("tab", { name: "LETTERS" })).toHaveAttribute("aria-selected", "true");
  });

  it("pins from the star and keeps the pin one click from a copy", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "euro sign" } });
    fireEvent.click(screen.getByLabelText("Pin EURO SIGN"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("pinned", ["€"]));

    // The rail survives the query that found it, and copies on one click.
    fireEvent.change(search(), { target: { value: "box" } });
    const rail = screen.getByLabelText("Pinned characters");
    fireEvent.click(within(rail).getByLabelText("EURO SIGN"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("€"));
  });

  it("unpins from the same star", async () => {
    await show({ pinned: ["€"] });
    expect(screen.getByLabelText("Pinned characters")).toBeInTheDocument();
    const rail = screen.getByLabelText("Pinned characters");
    fireEvent.click(within(rail).getByLabelText("Unpin EURO SIGN"));
    await waitFor(() => expect(set).toHaveBeenCalledWith("pinned", []));
    expect(screen.queryByLabelText("Pinned characters")).not.toBeInTheDocument();
  });

  it("pins the selection with Ctrl+P", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "em dash" } });
    fireEvent.keyDown(search(), { key: "p", ctrlKey: true });
    await waitFor(() => expect(set).toHaveBeenCalledWith("pinned", ["—"]));
    expect(writeText).not.toHaveBeenCalled();
  });

  it("hides the rail until something is pinned", async () => {
    await show();
    expect(screen.queryByLabelText("Pinned characters")).not.toBeInTheDocument();
  });

  it("says so when nothing matches", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "zzzznotathing" } });
    expect(screen.getByText("NO MATCH")).toBeInTheDocument();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
