// Generates app-icon.png — a 1024×1024 monochrome HUD "b" mark used as the
// source for `tauri icon`. Pure Node (zlib), no image deps.
//
// Rendered with signed distance fields so the mark gets anti-aliased edges and
// the brand's soft white glow (matches assets/logo-mark.svg).
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const BG = [10, 11, 13];
const FG = [244, 246, 248];
const TICK = [154, 161, 169];

// "b": a stem plus a ring bowl (same geometry as before, new dress).
const stem = { x0: 322, x1: 402, y0: 205, y1: 818 };
const ring = { cx: 562, cy: 592, rMid: 193, half: 43 };
const GLOW_REACH = 26; // px of soft falloff outside the mark
const GLOW_PEAK = 0.32;

/** Signed distance to the mark: negative inside, positive outside. */
function markDistance(x, y) {
  // rect SDF (outside distance only is what we need beyond ~1px)
  const dx = Math.max(stem.x0 - x, 0, x - stem.x1);
  const dy = Math.max(stem.y0 - y, 0, y - stem.y1);
  const inside =
    x >= stem.x0 && x <= stem.x1 && y >= stem.y0 && y <= stem.y1
      ? -Math.min(x - stem.x0, stem.x1 - x, y - stem.y0, stem.y1 - y)
      : Math.hypot(dx, dy);
  const dRing = Math.abs(Math.hypot(x - ring.cx, y - ring.cy) - ring.rMid) - ring.half;
  return Math.min(inside, dRing);
}

const buf = new Uint8Array(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const d = markDistance(x, y);
    // crisp core with 1px anti-aliasing + exponential glow halo outside
    const core = Math.max(0, Math.min(1, 0.5 - d));
    const glow = d > 0 ? Math.exp(-d / GLOW_REACH) * GLOW_PEAK : 0;
    const t = Math.min(1, core + glow);
    const i = (y * S + x) * 4;
    buf[i] = BG[0] + (FG[0] - BG[0]) * t;
    buf[i + 1] = BG[1] + (FG[1] - BG[1]) * t;
    buf[i + 2] = BG[2] + (FG[2] - BG[2]) * t;
    buf[i + 3] = 255;
  }
}

// corner tick framing
const set = (x, y, c) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = 255;
};
const rect = (x0, y0, x1, y1, c) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c);
};
const m = 72;
const len = 150;
const th = 14;
rect(m, m, m + len, m + th, TICK);
rect(m, m, m + th, m + len, TICK);
rect(S - m - len, m, S - m, m + th, TICK);
rect(S - m - th, m, S - m, m + len, TICK);
rect(m, S - m - th, m + len, S - m, TICK);
rect(m, S - m - len, m + th, S - m, TICK);
rect(S - m - len, S - m - th, S - m, S - m, TICK);
rect(S - m - th, S - m - len, S - m, S - m, TICK);

// ---- PNG encode ----
const crc32 = (bytes) => {
  let c = ~0;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
const stride = S * 4 + 1;
const raw = Buffer.alloc(S * stride);
for (let y = 0; y < S; y++) {
  raw[y * stride] = 0; // filter: none
  Buffer.from(buf.subarray(y * S * 4, (y + 1) * S * 4)).copy(raw, y * stride + 1);
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync("app-icon.png", png);
console.log(`wrote app-icon.png (${png.length} bytes)`);
