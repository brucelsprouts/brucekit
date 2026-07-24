import { describe, expect, it } from "vitest";
import { toBytes } from "./ipc";

/** The PNG magic number — enough to tell real bytes from a stringified array. */
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47];

describe("toBytes", () => {
  it("passes an ArrayBuffer through as its bytes", () => {
    const buf = new Uint8Array(PNG_HEAD).buffer;
    expect([...toBytes(buf)]).toEqual(PNG_HEAD);
  });

  it("converts the number[] form Tauri uses on a JSON payload", () => {
    // The case that broke image previews: Blob accepts a number[] without
    // complaint and stringifies it, producing "137,80,78,71" as text.
    expect([...toBytes(PNG_HEAD)]).toEqual(PNG_HEAD);
  });

  it("keeps a typed-array view's own window, not its whole buffer", () => {
    const backing = new Uint8Array([0, 0, ...PNG_HEAD, 0, 0]);
    const view = new Uint8Array(backing.buffer, 2, 4);
    expect([...toBytes(view)]).toEqual(PNG_HEAD);
  });

  it("produces a Blob of bytes rather than of digits", () => {
    // The property that actually matters, and the one that failed in the app:
    // 4 bytes, not the 12 characters of "137,80,78,71". Size is the tell —
    // passing the raw payload to Blob is silent, never an error.
    for (const payload of [PNG_HEAD, new Uint8Array(PNG_HEAD).buffer]) {
      expect(new Blob([toBytes(payload)]).size).toBe(4);
    }
    expect(new Blob([PNG_HEAD as unknown as BlobPart]).size).toBe(12);
  });

  it("handles an empty payload without inventing bytes", () => {
    expect(toBytes([]).length).toBe(0);
    expect(toBytes(new ArrayBuffer(0)).length).toBe(0);
  });
});
