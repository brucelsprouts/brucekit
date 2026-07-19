// Generates app-icon.png — a 1024×1024 HUD "b" mark used as the source for
// `tauri icon`. Pure Node (zlib), no image deps.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const BG = [10, 11, 13, 255];
const ACCENT = [77, 224, 176, 255];
const LINE = [49, 56, 66, 255];

const buf = new Uint8Array(S * S * 4);
const set = (x, y, c) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
  buf[i + 3] = c[3];
};
const rect = (x0, y0, x1, y1, c) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, c);
};

// background
rect(0, 0, S, S, BG);

// "b": a stem plus a ring bowl
const stem = { x0: 322, x1: 402, y0: 205, y1: 818 };
const ring = { cx: 562, cy: 592, rOut: 236, rIn: 150 };
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const inStem = x >= stem.x0 && x < stem.x1 && y >= stem.y0 && y < stem.y1;
    const dx = x - ring.cx;
    const dy = y - ring.cy;
    const d = Math.hypot(dx, dy);
    const inRing = d <= ring.rOut && d >= ring.rIn;
    if (inStem || inRing) set(x, y, ACCENT);
  }
}

// corner tick framing
const m = 72;
const len = 150;
const th = 14;
rect(m, m, m + len, m + th, LINE);
rect(m, m, m + th, m + len, LINE);
rect(S - m - len, m, S - m, m + th, LINE);
rect(S - m - th, m, S - m, m + len, LINE);
rect(m, S - m - th, m + len, S - m, LINE);
rect(m, S - m - len, m + th, S - m, LINE);
rect(S - m - len, S - m - th, S - m, S - m, LINE);
rect(S - m - th, S - m - len, S - m, S - m, LINE);

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
