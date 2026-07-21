import { describe, expect, it } from "vitest";
import type { PingEntry } from "../../core/ipc";
import {
  buildSegments,
  computeYMax,
  filterToView,
  formatGap,
  fullSpan,
  GAP_SEPARATOR_W,
  mapX,
  mapXInverse,
  MAX_SPAN_MS,
  MIN_SPAN_MS,
  panBy,
  resolveView,
  spanForActiveSeconds,
  zoomAt,
} from "./graph";

const ok = (ts: number, ms = 20): PingEntry => ({ ts, ms, status: "ok" });

describe("buildSegments", () => {
  it("keeps closely spaced samples in one segment spanning the plot", () => {
    const entries = [ok(0), ok(5000), ok(10_000)];
    const segs = buildSegments(entries, 40, 300);

    expect(segs).toHaveLength(1);
    expect(segs[0].xStart).toBe(40);
    expect(segs[0].xWidth).toBe(300);
  });

  it("splits on an offline gap and collapses the dead time", () => {
    // Two 10s sessions separated by an hour of the app being off.
    const hour = 3_600_000;
    const entries = [ok(0), ok(10_000), ok(hour), ok(hour + 10_000)];
    const segs = buildSegments(entries, 0, 314);

    expect(segs).toHaveLength(2);
    // The hour occupies exactly one fixed separator, not proportional space.
    const active = 314 - GAP_SEPARATOR_W;
    expect(segs[0].xWidth).toBeCloseTo(active / 2);
    expect(segs[1].xWidth).toBeCloseTo(active / 2);
    expect(segs[1].xStart).toBeCloseTo(segs[0].xWidth + GAP_SEPARATOR_W);
  });

  it("butts segments together when the dead time is hidden", () => {
    // "Hide inactive intervals": the separators go, so the sessions read as
    // one continuous trace and all the width goes to real samples.
    const hour = 3_600_000;
    const entries = [ok(0), ok(10_000), ok(hour), ok(hour + 10_000)];
    const segs = buildSegments(entries, 0, 314, 0);

    expect(segs).toHaveLength(2);
    expect(segs[0].xWidth).toBeCloseTo(157);
    expect(segs[1].xStart).toBeCloseTo(157);
    // No pixels lost to dead time.
    expect(segs[0].xWidth + segs[1].xWidth).toBeCloseTo(314);
  });

  it("still maps a timestamp into the right place with gaps hidden", () => {
    const hour = 3_600_000;
    const entries = [ok(0), ok(10_000), ok(hour), ok(hour + 10_000)];
    const segs = buildSegments(entries, 0, 314, 0);

    expect(mapX(segs, 0)).toBeCloseTo(0);
    expect(mapX(segs, 10_000)).toBeCloseTo(157);
    expect(mapX(segs, hour)).toBeCloseTo(157);
    expect(mapX(segs, hour + 10_000)).toBeCloseTo(314);
  });

  it("weights segments by their own active duration", () => {
    const hour = 3_600_000;
    // 30s session, then a 10s session.
    const entries = [ok(0), ok(30_000), ok(hour), ok(hour + 10_000)];
    const segs = buildSegments(entries, 0, 100 + GAP_SEPARATOR_W);

    expect(segs[0].xWidth).toBeCloseTo(75);
    expect(segs[1].xWidth).toBeCloseTo(25);
  });

  it("returns nothing for no entries", () => {
    expect(buildSegments([], 0, 300)).toEqual([]);
  });

  it("gives a single sample a nonzero width", () => {
    const segs = buildSegments([ok(1000)], 0, 200);
    expect(segs).toHaveLength(1);
    expect(segs[0].xWidth).toBeGreaterThan(0);
  });
});

describe("mapX", () => {
  it("maps segment ends to the segment's pixel range", () => {
    const entries = [ok(0), ok(10_000)];
    const segs = buildSegments(entries, 40, 300);

    expect(mapX(segs, 0)).toBeCloseTo(40);
    expect(mapX(segs, 10_000)).toBeCloseTo(340);
    expect(mapX(segs, 5000)).toBeCloseTo(190);
  });

  it("places a timestamp inside the gap at the edge of a segment", () => {
    const hour = 3_600_000;
    const entries = [ok(0), ok(10_000), ok(hour), ok(hour + 10_000)];
    const segs = buildSegments(entries, 0, 314);

    // Mid-gap clamps to the nearest segment's boundary, never off-plot.
    const x = mapX(segs, hour / 2);
    expect(x).toBeGreaterThanOrEqual(segs[0].xStart);
    expect(x).toBeLessThanOrEqual(segs[1].xStart + segs[1].xWidth);
  });

  it("is safe with no segments", () => {
    expect(mapX([], 123)).toBe(0);
  });
});

describe("computeYMax", () => {
  it("floors at 100ms for a calm connection", () => {
    expect(computeYMax([ok(0, 12), ok(1, 20)])).toBe(100);
  });

  it("adds headroom above the worst ping", () => {
    expect(computeYMax([ok(0, 20), ok(1, 500)])).toBe(600);
  });

  it("ignores drops, which carry ms = -1", () => {
    const drop: PingEntry = { ts: 2, ms: -1, status: "drop" };
    expect(computeYMax([ok(0, 200), drop])).toBe(240);
  });
});

describe("mapXInverse", () => {
  it("round-trips with mapX inside a segment", () => {
    const segs = buildSegments([ok(0), ok(10_000)], 40, 300);
    for (const ts of [0, 2500, 5000, 10_000]) {
      expect(mapXInverse(segs, mapX(segs, ts))).toBeCloseTo(ts, 3);
    }
  });

  it("clamps outside the plot to the data bounds", () => {
    const segs = buildSegments([ok(1000), ok(9000)], 40, 300);
    expect(mapXInverse(segs, -50)).toBe(1000);
    expect(mapXInverse(segs, 9999)).toBe(9000);
  });

  it("resolves a collapsed separator to the end of the prior segment", () => {
    const hour = 3_600_000;
    const segs = buildSegments([ok(0), ok(10_000), ok(hour), ok(hour + 10_000)], 0, 314);
    const gapMid = segs[0].xStart + segs[0].xWidth + GAP_SEPARATOR_W / 2;
    expect(mapXInverse(segs, gapMid)).toBe(10_000);
  });

  it("is null with no data", () => {
    expect(mapXInverse([], 100)).toBeNull();
  });
});

describe("resolveView", () => {
  it("follows the newest sample while live", () => {
    const entries = [ok(0), ok(600_000)];
    const view = resolveView(entries, 300_000, true, null);
    // Window ends just past the last sample and spans backwards.
    expect(view.endMs).toBe(600_000 + 60_000);
    expect(view.endMs - view.startMs).toBe(300_000);
  });

  it("pins to the anchor once the user has taken over", () => {
    const entries = [ok(0), ok(600_000)];
    const view = resolveView(entries, 120_000, false, 400_000);
    expect(view.endMs).toBe(400_000);
    expect(view.startMs).toBe(280_000);
  });

  it("falls back to live when there is no anchor", () => {
    const entries = [ok(50_000)];
    expect(resolveView(entries, 1000, false, null).endMs).toBe(50_000 + 60_000);
  });
});

describe("filterToView", () => {
  const entries = [ok(0), ok(1000), ok(2000), ok(3000), ok(4000), ok(5000)];

  it("keeps one sample of context beyond each edge", () => {
    const inView = filterToView(entries, { startMs: 2000, endMs: 3000 });
    // 2000..3000 plus one either side.
    expect(inView.map((e) => e.ts)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("returns everything when the window covers the data", () => {
    expect(filterToView(entries, { startMs: -1, endMs: 9999 })).toHaveLength(6);
  });

  it("handles a window past the end of the data", () => {
    const inView = filterToView(entries, { startMs: 90_000, endMs: 99_000 });
    expect(inView.length).toBeGreaterThan(0);
    expect(inView[inView.length - 1].ts).toBe(5000);
  });

  it("is empty for no entries", () => {
    expect(filterToView([], { startMs: 0, endMs: 10 })).toEqual([]);
  });
});

describe("zoomAt", () => {
  const view = { startMs: 0, endMs: 100_000 };
  const span = 100_000;

  it("keeps the anchored instant under the cursor", () => {
    // Anchor at 25% across the window; it must stay at 25% after zooming.
    const anchor = 25_000;
    const next = zoomAt(view, span, anchor, -1);
    const nextStart = next.endMs - next.spanMs;
    expect((anchor - nextStart) / next.spanMs).toBeCloseTo(0.25, 6);
  });

  it("zooms in on scroll up and out on scroll down", () => {
    expect(zoomAt(view, span, 50_000, -1).spanMs).toBeLessThan(span);
    expect(zoomAt(view, span, 50_000, 1).spanMs).toBeGreaterThan(span);
  });

  it("clamps to the zoom limits", () => {
    expect(zoomAt(view, MIN_SPAN_MS, 0, -1).spanMs).toBe(MIN_SPAN_MS);
    expect(zoomAt(view, MAX_SPAN_MS, 0, 1).spanMs).toBe(MAX_SPAN_MS);
  });
});

describe("panBy", () => {
  it("moves the window back in time when dragged right", () => {
    const view = { startMs: 0, endMs: 100_000 };
    // Dragging right by a quarter of the plot shows a quarter-span earlier.
    expect(panBy(view, 100_000, 0.25)).toBe(75_000);
    expect(panBy(view, 100_000, -0.25)).toBe(125_000);
  });
});

describe("spanForActiveSeconds", () => {
  it("matches wall time when the monitor never stopped", () => {
    // Continuous 10-minute run, ask for the last 5 minutes of it.
    const entries = Array.from({ length: 121 }, (_, i) => ok(i * 5000));
    expect(spanForActiveSeconds(entries, 300)).toBeCloseTo(300_000 + 60_000, -3);
  });

  it("reaches past an offline stretch to find real samples", () => {
    // 5 min of pings, app off for 10 hours, then 5 more min. Asking for an
    // hour of *monitoring* must reach back through the dead time to the
    // earlier session, not stop at the hour boundary and find nothing.
    const tenHours = 36_000_000;
    const first = Array.from({ length: 61 }, (_, i) => ok(i * 5000));
    const second = Array.from({ length: 61 }, (_, i) => ok(tenHours + i * 5000));
    const span = spanForActiveSeconds([...first, ...second], 3600);

    const view = resolveView([...first, ...second], span, true, null);
    expect(view.startMs).toBeLessThanOrEqual(0);
  });

  it("stops once it has the requested amount of active time", () => {
    // 30 min continuous; asking for 5 min must not drag in all of it.
    const entries = Array.from({ length: 361 }, (_, i) => ok(i * 5000));
    const span = spanForActiveSeconds(entries, 300);
    const view = resolveView(entries, span, true, null);

    expect(view.startMs).toBeGreaterThan(1_500_000 - 400_000);
  });

  it("falls back to the whole log when there isn't that much data yet", () => {
    const entries = [ok(0), ok(5000), ok(10_000)];
    const span = spanForActiveSeconds(entries, 3600);
    expect(span).toBeGreaterThanOrEqual(10_000);
  });

  it("survives an empty log", () => {
    expect(spanForActiveSeconds([], 3600)).toBe(MIN_SPAN_MS);
  });
});

describe("fullSpan", () => {
  it("covers the whole data extent", () => {
    expect(fullSpan([ok(0), ok(3_600_000)])).toBeGreaterThanOrEqual(3_600_000);
  });

  it("has a floor for sparse data", () => {
    expect(fullSpan([])).toBe(MIN_SPAN_MS);
    expect(fullSpan([ok(5)])).toBe(MIN_SPAN_MS);
  });
});

describe("formatGap", () => {
  it("scales the unit to the gap length", () => {
    expect(formatGap(45_000)).toBe("45s");
    expect(formatGap(240_000)).toBe("4m");
    expect(formatGap(7_800_000)).toBe("2h 10m");
    expect(formatGap(273_600_000)).toBe("3d 4h");
  });
});
