import { describe, expect, it, vi } from "vitest";
import type { PingEntry } from "../../core/ipc";
import { drawGraph } from "./DcheckPanel";

/**
 * Rendering tests for the ported dcheck line graph. jsdom has no real canvas,
 * so we hand `drawGraph` a recording 2D context and assert on the drawing
 * commands — enough to prove the trace is a stroked line (not bars), that it
 * breaks at drops/gaps, and that the event colors land where dcheck puts them.
 */
type Call = { op: string; args: unknown[] };

function recordingCanvas(width = 400, height = 168) {
  const calls: Call[] = [];
  const state: { strokeStyle: string; fillStyle: string; lineWidth: number } = {
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 0,
  };
  /** Style at the moment each op ran, so color↔shape pairing is checkable. */
  const styled: Array<Call & { strokeStyle: string; fillStyle: string; lineWidth: number }> = [];

  const record =
    (op: string) =>
    (...args: unknown[]) => {
      const call = { op, args };
      calls.push(call);
      styled.push({ ...call, ...state });
    };

  const ctx = {
    get strokeStyle() {
      return state.strokeStyle;
    },
    set strokeStyle(v: string) {
      state.strokeStyle = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get lineWidth() {
      return state.lineWidth;
    },
    set lineWidth(v: number) {
      state.lineWidth = v;
    },
    lineJoin: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    setTransform: record("setTransform"),
    clearRect: record("clearRect"),
    beginPath: record("beginPath"),
    moveTo: record("moveTo"),
    lineTo: record("lineTo"),
    stroke: record("stroke"),
    fill: record("fill"),
    arc: record("arc"),
    fillRect: record("fillRect"),
    strokeRect: record("strokeRect"),
    fillText: record("fillText"),
    setLineDash: record("setLineDash"),
    measureText: () => ({ width: 40 }),
  };

  const canvas = {
    clientWidth: width,
    clientHeight: height,
    width,
    height,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  return { canvas, calls, styled };
}

const WHITE = "#f4f6f8";
const AMBER = "#ff8c00";
const RED = "#ff2020";

/** A run of pings one second apart, so they form one continuous segment. */
function series(specs: Array<Partial<PingEntry>>): PingEntry[] {
  return specs.map((s, i) => ({
    ts: 1_700_000_000_000 + i * 1000,
    ms: 20,
    status: "ok",
    ...s,
  })) as PingEntry[];
}

describe("drawGraph", () => {
  it("strokes a connected line through healthy pings", () => {
    const { canvas, styled } = recordingCanvas();
    drawGraph(canvas, series([{ ms: 20 }, { ms: 30 }, { ms: 25 }, { ms: 40 }]), 100, null);

    const lineTos = styled.filter((c) => c.op === "lineTo" && c.strokeStyle === WHITE);
    // Four points on one unbroken trace = three connecting segments.
    expect(lineTos).toHaveLength(3);
    expect(styled.some((c) => c.op === "moveTo" && c.strokeStyle === WHITE)).toBe(true);
    // A line graph, not a bar graph: no filled bars in the plot.
    expect(styled.filter((c) => c.op === "fillRect" && c.fillStyle === WHITE)).toHaveLength(0);
  });

  it("breaks the trace at a drop and draws a red disconnect bar", () => {
    const { canvas, styled } = recordingCanvas();
    drawGraph(
      canvas,
      series([{ ms: 20 }, { ms: 25 }, { ms: -1, status: "drop" }, { ms: 30 }, { ms: 28 }]),
      100,
      null,
    );

    // Two pings either side of the drop → one lineTo per side, not three.
    const lineTos = styled.filter((c) => c.op === "lineTo" && c.strokeStyle === WHITE);
    expect(lineTos).toHaveLength(2);

    // The drop is a full-height vertical rule in red, with a wider glow pass.
    const redStrokes = styled.filter((c) => c.op === "stroke" && c.strokeStyle === RED);
    expect(redStrokes.length).toBeGreaterThan(0);
    expect(redStrokes.every((c) => c.lineWidth === 2)).toBe(true);
    expect(
      styled.some((c) => c.op === "stroke" && c.strokeStyle.startsWith("rgba(255, 32, 32")),
    ).toBe(true);
  });

  it("marks high-latency samples with amber dots", () => {
    const { canvas, styled } = recordingCanvas();
    drawGraph(canvas, series([{ ms: 20 }, { ms: 400, status: "high" }, { ms: 25 }]), 100, null);

    const amberArcs = styled.filter((c) => c.op === "arc" && c.fillStyle === AMBER);
    expect(amberArcs).toHaveLength(1);
    // The trace still runs through the high sample — only drops break it.
    expect(styled.filter((c) => c.op === "lineTo" && c.strokeStyle === WHITE)).toHaveLength(2);
  });

  it("breaks the trace across an offline gap without dropping data", () => {
    const hour = 3_600_000;
    const entries: PingEntry[] = [
      { ts: 0, ms: 20, status: "ok" },
      { ts: 1000, ms: 22, status: "ok" },
      { ts: hour, ms: 24, status: "ok" },
      { ts: hour + 1000, ms: 26, status: "ok" },
    ];
    const { canvas, styled } = recordingCanvas();
    drawGraph(canvas, entries, 100, null);

    // One connection within each session, none spanning the gap.
    expect(styled.filter((c) => c.op === "lineTo" && c.strokeStyle === WHITE)).toHaveLength(2);
    // The collapsed gap is painted as a separator band.
    expect(styled.some((c) => c.op === "fillRect")).toBe(true);
  });

  it("draws the threshold hairline only when it fits under the ceiling", () => {
    const inRange = recordingCanvas();
    drawGraph(inRange.canvas, series([{ ms: 20 }]), 80, null);
    expect(
      inRange.styled.some(
        (c) => c.op === "stroke" && c.strokeStyle.startsWith("rgba(255, 140, 0"),
      ),
    ).toBe(true);

    // A threshold above the y-axis ceiling would be off-plot; skip it.
    const offPlot = recordingCanvas();
    drawGraph(offPlot.canvas, series([{ ms: 20 }]), 5000, null);
    expect(
      offPlot.styled.some(
        (c) => c.op === "stroke" && c.strokeStyle.startsWith("rgba(255, 140, 0"),
      ),
    ).toBe(false);
  });

  it("shows a placeholder instead of an empty plot", () => {
    const { canvas, calls } = recordingCanvas();
    drawGraph(canvas, [], 100, null);

    const text = calls.filter((c) => c.op === "fillText").map((c) => c.args[0]);
    expect(text).toEqual(["Waiting for ping data…"]);
    expect(calls.some((c) => c.op === "lineTo")).toBe(false);
  });

  it("draws a crosshair and readout for the hovered sample", () => {
    const { canvas, calls, styled } = recordingCanvas();
    const entries = series([{ ms: 20 }, { ms: 30 }, { ms: 25 }]);
    // Hover mid-plot; the nearest sample gets a dot, crosshair, and tooltip.
    drawGraph(canvas, entries, 100, 200);

    expect(styled.some((c) => c.op === "arc" && c.fillStyle === WHITE)).toBe(true);
    expect(calls.some((c) => c.op === "strokeRect")).toBe(true);
    const labels = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(labels.some((t) => t.endsWith("ms"))).toBe(true);
  });

  it("reports the offline duration when hovering a gap separator", () => {
    const hour = 3_600_000;
    const entries: PingEntry[] = [
      { ts: 0, ms: 20, status: "ok" },
      { ts: 1000, ms: 22, status: "ok" },
      { ts: hour, ms: 24, status: "ok" },
      { ts: hour + 1000, ms: 26, status: "ok" },
    ];
    // The separator sits just past the first segment's right edge.
    const { canvas, calls } = recordingCanvas();
    const plotW = 400 - 44 - 12;
    const gapStart = 44 + (plotW - 14) / 2;
    drawGraph(canvas, entries, 100, gapStart + 7);

    const labels = calls.filter((c) => c.op === "fillText").map((c) => String(c.args[0]));
    expect(labels.some((t) => t.startsWith("OFF "))).toBe(true);
  });

  it("survives a canvas too small to hold its padding", () => {
    const { canvas, calls } = recordingCanvas(20, 20);
    expect(() => drawGraph(canvas, series([{ ms: 20 }]), 100, null)).not.toThrow();
    expect(calls.some((c) => c.op === "lineTo")).toBe(false);
  });
});

describe("drawGraph device pixel ratio", () => {
  it("scales the backing store to the display density", () => {
    vi.stubGlobal("devicePixelRatio", 2);
    const { canvas, calls } = recordingCanvas(400, 168);
    drawGraph(canvas, series([{ ms: 20 }]), 100, null);

    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(336);
    expect(calls[0]).toEqual({ op: "setTransform", args: [2, 0, 0, 2, 0, 0] });
    vi.unstubAllGlobals();
  });
});
