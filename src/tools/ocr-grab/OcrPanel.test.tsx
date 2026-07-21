import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types";
import { EV_OCR_DONE, type OcrDonePayload } from "../../core/events";
import { undoSlot } from "../../core/undo";

/** Captured `listen` handlers, so a test can play the overlay's part. */
const handlers = new Map<string, (e: { payload: unknown }) => void>();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (event: string, handler: (e: { payload: unknown }) => void) => {
    handlers.set(event, handler);
    return Promise.resolve(() => handlers.delete(event));
  },
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: vi.fn(() => Promise.resolve()),
}));
vi.mock("../../core/overlay", () => ({ launchCapture: vi.fn(() => Promise.resolve()) }));

// Imported after the mocks so the panel picks them up.
const { OcrPanel } = await import("./OcrPanel");

function makeCtx(): ToolContext {
  return {
    invoke: vi.fn() as unknown as ToolContext["invoke"],
    toast: vi.fn(),
    closeLauncher: vi.fn(),
    settings: { get: vi.fn(), set: vi.fn() } as unknown as ToolContext["settings"],
  };
}

/** Feeds the panel a finished scan the way the overlay would. */
async function deliverScan(text: string) {
  await waitFor(() => expect(handlers.get(EV_OCR_DONE)).toBeDefined());
  await act(async () => {
    handlers.get(EV_OCR_DONE)!({ payload: { text } satisfies OcrDonePayload });
  });
  await screen.findByDisplayValue(text);
}

const clearButton = () => screen.getByRole("button", { name: "Clear" });
const click = (el: HTMLElement) => act(() => void fireEvent.click(el));

beforeEach(() => {
  handlers.clear();
  // Undo is app-wide state; a leftover entry would leak between tests.
  undoSlot.take();
});

afterEach(() => vi.clearAllMocks());

describe("OcrPanel clearing", () => {
  it("asks before discarding a scan", async () => {
    render(<OcrPanel ctx={makeCtx()} />);
    await deliverScan("recognized text");

    await click(clearButton());

    expect(screen.getByText("DISCARD THIS SCAN?")).toBeInTheDocument();
    // The scan is still on screen — asking must not be the same as doing.
    expect(screen.getByDisplayValue("recognized text")).toBeInTheDocument();
  });

  it("keeps the scan when the prompt is dismissed", async () => {
    render(<OcrPanel ctx={makeCtx()} />);
    await deliverScan("recognized text");

    await click(clearButton());
    await click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByText("DISCARD THIS SCAN?")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("recognized text")).toBeInTheDocument();
  });

  it("discards the scan once confirmed", async () => {
    render(<OcrPanel ctx={makeCtx()} />);
    await deliverScan("recognized text");

    await click(clearButton());
    await click(clearButton());

    expect(screen.queryByDisplayValue("recognized text")).not.toBeInTheDocument();
    expect(screen.getByText("NO SCAN YET")).toBeInTheDocument();
  });

  it("offers the discarded scan back through undo", async () => {
    render(<OcrPanel ctx={makeCtx()} />);
    await deliverScan("recognized text");

    await click(clearButton());
    await click(clearButton());

    const entry = undoSlot.take();
    expect(entry?.label).toBe("the scan");
    await act(async () => {
      await entry!.run();
    });
    expect(await screen.findByDisplayValue("recognized text")).toBeInTheDocument();
  });

  it("drops a pending prompt when a new scan lands", async () => {
    // Otherwise the confirm is left asking about text that is already gone,
    // and the next click discards something the user never meant.
    render(<OcrPanel ctx={makeCtx()} />);
    await deliverScan("first scan");
    await click(clearButton());
    expect(screen.getByText("DISCARD THIS SCAN?")).toBeInTheDocument();

    await deliverScan("second scan");

    expect(screen.queryByText("DISCARD THIS SCAN?")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("second scan")).toBeInTheDocument();
  });

  it("has nothing to clear before the first scan", () => {
    render(<OcrPanel ctx={makeCtx()} />);
    expect(clearButton()).toBeDisabled();
  });
});
