import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types";
import type { Clip } from "../../core/ipc";

vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));

// Imported after the mock so the panel picks it up.
const { ClipsPanel } = await import("./ClipsPanel");

const invoke = vi.fn();

function makeCtx(clips: Clip[]): ToolContext {
  invoke.mockImplementation((cmd: string) => {
    if (cmd === "clips_list") return Promise.resolve(clips);
    // number[], the shape that broke previews in the real app — a test using
    // an ArrayBuffer here would have passed while the app stayed broken.
    if (cmd === "clips_image") return Promise.resolve([0x89, 0x50, 0x4e, 0x47]);
    return Promise.resolve(null);
  });
  return {
    invoke: invoke as unknown as ToolContext["invoke"],
    toast: vi.fn(),
    closeLauncher: vi.fn(),
    settings: {
      get: vi.fn((_key: string, fallback: unknown) => Promise.resolve(fallback)),
      set: vi.fn(() => Promise.resolve()),
    } as unknown as ToolContext["settings"],
  };
}

function textClip(over: Partial<Clip> = {}): Clip {
  return { id: 1, text: "plain words", pinned: false, createdAt: Date.now(), ...over };
}

function imageClip(): Clip {
  return {
    id: 2,
    text: "Image 1920×1080",
    pinned: false,
    createdAt: Date.now(),
    image: {
      width: 1920,
      height: 1080,
      file: "2.png",
      thumb: "2.thumb.png",
      hash: "abc",
    },
  };
}

async function show(clips: Clip[]) {
  const ctx = makeCtx(clips);
  const view = render(<ClipsPanel ctx={ctx} />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("clips_list", { search: null }));
  return view;
}

const click = (el: HTMLElement) => act(() => void fireEvent.click(el));

/** Blobs handed to createObjectURL, so a test can check what got wrapped. */
let blobs: Blob[] = [];

beforeEach(() => {
  // jsdom ships neither, and the thumbnail loader needs both.
  blobs = [];
  URL.createObjectURL = vi.fn((blob: Blob) => {
    blobs.push(blob);
    return "blob:clip";
  });
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => vi.clearAllMocks());

describe("ClipsPanel image clips", () => {
  it("shows a copied picture as a preview rather than as its label", async () => {
    await show([imageClip()]);

    // The row renders first and the preview lands when its bytes arrive, so
    // the image is what has to be waited on, not the row.
    const row = await screen.findByRole("button", { name: /copy image 1920×1080/i });
    await waitFor(() => expect(row.querySelector("img")).toHaveAttribute("src", "blob:clip"));
    // The thumbnail is what's fetched — never the full-resolution original,
    // which is only ever loaded to put back on the clipboard.
    expect(invoke).toHaveBeenCalledWith("clips_image", { id: 2 });
    expect(screen.getByText("1920×1080")).toBeInTheDocument();

    // The blob must hold the 4 PNG bytes, not the 12 characters of
    // "137,80,78,71" — the silent stringification that broke the real preview.
    expect(blobs).toHaveLength(1);
    expect(blobs[0].size).toBe(4);
    expect(blobs[0].type).toBe("image/png");
  });

  it("copies the picture, not its label, when the row is clicked", async () => {
    await show([imageClip()]);

    await click(screen.getByRole("button", { name: /copy image/i }));

    expect(invoke).toHaveBeenCalledWith("clips_copy", { id: 2, plain: false });
  });

  it("falls back to a placeholder when the preview will not render", async () => {
    // The bytes can arrive and the render still fail — a CSP without `blob:`
    // does precisely that. Showing the webview's broken-image glyph would read
    // as a corrupt clip rather than a display problem.
    await show([imageClip()]);
    const row = await screen.findByRole("button", { name: /copy image/i });
    const img = await waitFor(() => {
      const found = row.querySelector("img");
      expect(found).not.toBeNull();
      return found!;
    });

    await act(async () => void fireEvent.error(img));

    expect(row.querySelector("img")).toBeNull();
    expect(screen.getByText("?")).toBeInTheDocument();
  });

  it("survives an image whose file has gone missing", async () => {
    // The row still has to be deletable, so a broken preview cannot take the
    // panel down with it.
    invoke.mockImplementation((cmd: string) =>
      cmd === "clips_list"
        ? Promise.resolve([imageClip()])
        : cmd === "clips_image"
          ? Promise.reject("could not read 2.thumb.png")
          : Promise.resolve(null),
    );
    render(<ClipsPanel ctx={makeCtx([imageClip()])} />);

    expect(await screen.findByRole("button", { name: "Delete clip" })).toBeInTheDocument();
  });
});

describe("ClipsPanel formatted text", () => {
  it("shows the plain text and never the markup", async () => {
    const { container } = await show([
      textClip({ text: "bold words", html: "<b>bold words</b>" }),
    ]);

    expect(await screen.findByText("bold words")).toBeInTheDocument();
    expect(container.querySelector("b")).toBeNull();
  });

  it("keeps the styling on a normal copy", async () => {
    await show([textClip({ html: "<b>plain words</b>" })]);

    // The row names itself with its text, exactly as an unformatted one does.
    await click(await screen.findByRole("button", { name: "plain words" }));

    expect(invoke).toHaveBeenCalledWith("clips_copy", { id: 1, plain: false });
  });

  it("offers a plain-text copy alongside it", async () => {
    await show([textClip({ html: "<b>plain words</b>" })]);

    await click(screen.getByRole("button", { name: "Copy without formatting" }));

    expect(invoke).toHaveBeenCalledWith("clips_copy", { id: 1, plain: true });
  });

  it("leaves the plain-text button off a clip that has no styling to drop", async () => {
    await show([textClip()]);

    expect(screen.queryByRole("button", { name: "Copy without formatting" })).toBeNull();
  });
});
