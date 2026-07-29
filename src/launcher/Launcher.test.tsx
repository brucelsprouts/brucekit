import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn((cmd: string, _args?: unknown) => {
  if (cmd === "get_config") {
    return Promise.resolve({
      hotkey: "F1",
      launchOnStartup: false,
      disabledModules: [],
      pinnedModules: [],
      moduleHotkeys: {},
      ecoMode: false,
      launcherSize: null,
      launcherSizes: {},
      tools: {},
    });
  }
  return Promise.resolve(null);
});

vi.mock("../core/ipc", async () => {
  const actual = await vi.importActual<typeof import("../core/ipc")>("../core/ipc");
  return { ...actual, invoke: (cmd: string, args?: unknown) => invoke(cmd, args) };
});

// Tray/hotkey signals never arrive in a test, but the listeners must resolve.
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    hide: () => Promise.resolve(),
    startDragging: () => Promise.resolve(),
    scaleFactor: () => Promise.resolve(1),
    onResized: () => Promise.resolve(() => {}),
  }),
}));

const { Launcher } = await import("./Launcher");
const { ToolHost } = await import("./ToolHost");

const resizeCalls = () => invoke.mock.calls.filter(([cmd]) => cmd === "resize_launcher");
const search = () => screen.getByLabelText("Search tools");

// jsdom reports every box as zero-sized, and the grid's measuring effect
// deliberately bails on a zero measurement (a real webview that hasn't laid out
// yet would otherwise clamp the window to its minimum). Without a stub the
// resize never fires at all and the sizing tests below would pass vacuously.
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ top: 100, bottom: 400, left: 0, right: 540, width: 540, height: 100 }) as DOMRect;
});

beforeEach(() => {
  invoke.mockClear();
});

async function show() {
  const view = render(<Launcher />);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith("get_config", undefined));
  return view;
}

describe("grid window sizing", () => {
  it("fits the window to the grid at rest", async () => {
    await show();
    await waitFor(() => expect(resizeCalls().length).toBeGreaterThan(0));
    const [, args] = resizeCalls()[0];
    expect(args).toMatchObject({ width: 540 });
    expect((args as { height: number }).height).toBeGreaterThan(0);
  });

  it("does not resize the window on every keystroke", async () => {
    await show();
    const before = resizeCalls().length;

    for (const q of ["c", "co", "col", "zzz"]) {
      fireEvent.change(search(), { target: { value: q } });
    }
    await waitFor(() => expect(search()).toHaveValue("zzz"));

    // The regression this guards: fitting the window to the filtered result
    // count made the grid pulse as you typed, so the tile you were aiming at
    // moved under the cursor. At rest the grid is one stable size and
    // filtering just empties the box it already has.
    expect(resizeCalls().length).toBe(before);
  });

  it("re-fits once the search is cleared", async () => {
    await show();
    fireEvent.change(search(), { target: { value: "col" } });
    await waitFor(() => expect(search()).toHaveValue("col"));
    const whileSearching = resizeCalls().length;

    fireEvent.change(search(), { target: { value: "" } });
    await waitFor(() => expect(search()).toHaveValue(""));

    // Back at rest the grid owns its size again — the guard suppresses the
    // resize while searching, it does not disable it for good.
    expect(resizeCalls().length).toBeGreaterThan(whileSearching);
  });
});

describe("escape hints", () => {
  it("tells you Esc closes at the grid", async () => {
    await show();
    expect(screen.getByText(/\[esc\] close/i)).toBeInTheDocument();
  });

  it("tells you Esc goes back inside a panel", async () => {
    await show();
    fireEvent.click(screen.getByText("Color picker"));
    await waitFor(() => expect(screen.getByText("[ESC] BACK")).toBeInTheDocument());
    // ...and the grid's own hint is gone with the grid.
    expect(screen.queryByText(/\[esc\] close/i)).not.toBeInTheDocument();
  });

  it("leaves an ordinary panel unmarked", async () => {
    await show();
    fireEvent.click(screen.getByText("Color picker"));
    await waitFor(() => expect(screen.getByText("[ESC] BACK")).toBeInTheDocument());
    expect(screen.queryByText("STAYS OPEN")).not.toBeInTheDocument();
  });
});

describe("ToolHost header marks", () => {
  // Driven with synthetic modules rather than through the launcher: the claim
  // is about what the header says for a given `keepOpen`, and routing it
  // through a real panel would make the test hostage to that panel's data.
  const host = (keepOpen: boolean) => {
    const tool = {
      id: "fake",
      name: "Fake",
      description: "A panel",
      kind: "panel" as const,
      keepOpen,
      icon: () => null,
      render: () => <p>body</p>,
    };
    const ctx = {
      invoke: vi.fn(),
      toast: vi.fn(),
      closeLauncher: vi.fn(),
      settings: { get: vi.fn(), set: vi.fn() },
    };
    return render(<ToolHost tool={tool} ctx={ctx as never} />);
  };

  it("marks a panel that stays open on click-away", () => {
    host(true);
    expect(screen.getByText("STAYS OPEN")).toBeInTheDocument();
    expect(screen.getByText("[ESC] BACK")).toBeInTheDocument();
  });

  it("leaves an ordinary panel unmarked", () => {
    host(false);
    expect(screen.queryByText("STAYS OPEN")).not.toBeInTheDocument();
    expect(screen.getByText("[ESC] BACK")).toBeInTheDocument();
  });
});
