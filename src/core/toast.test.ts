import { describe, expect, it } from "vitest";
import { toastReducer, type Toast } from "./toast";

const t = (id: number, message = "hi"): Toast => ({ id, message, kind: "info", ttl: 1000 });

describe("toastReducer", () => {
  it("adds toasts newest-last", () => {
    let s = toastReducer([], { type: "add", toast: t(1, "a") });
    s = toastReducer(s, { type: "add", toast: t(2, "b") });
    expect(s.map((x) => x.message)).toEqual(["a", "b"]);
  });

  it("dismisses by id", () => {
    const s = toastReducer([t(1), t(2), t(3)], { type: "dismiss", id: 2 });
    expect(s.map((x) => x.id)).toEqual([1, 3]);
  });

  it("clears all", () => {
    expect(toastReducer([t(1), t(2)], { type: "clear" })).toEqual([]);
  });

  it("caps the queue at 4, dropping the oldest", () => {
    let s: Toast[] = [];
    for (let i = 1; i <= 6; i++) s = toastReducer(s, { type: "add", toast: t(i) });
    expect(s.map((x) => x.id)).toEqual([3, 4, 5, 6]);
  });
});
