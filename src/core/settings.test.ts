import { describe, expect, it } from "vitest";
import { getToolValue, setToolValue, type ToolsBag } from "./settings";

describe("getToolValue", () => {
  const bag: ToolsBag = { "color-picker": { format: "rgb" } };

  it("reads a namespaced value", () => {
    expect(getToolValue(bag, "color-picker", "format", "hex")).toBe("rgb");
  });

  it("falls back when the tool or key is absent", () => {
    expect(getToolValue(bag, "color-picker", "missing", "hex")).toBe("hex");
    expect(getToolValue(bag, "other-tool", "format", "hex")).toBe("hex");
    expect(getToolValue(undefined, "color-picker", "format", "hex")).toBe("hex");
  });
});

describe("setToolValue", () => {
  it("writes only within the tool's namespace", () => {
    const bag: ToolsBag = { "tool-a": { keep: 1 }, "tool-b": { x: 2 } };
    const next = setToolValue(bag, "tool-b", "x", 99);

    expect(next["tool-b"]).toEqual({ x: 99 });
    // sibling namespace is untouched — a tool cannot clobber another's config.
    expect(next["tool-a"]).toEqual({ keep: 1 });
  });

  it("does not mutate the input bag", () => {
    const bag: ToolsBag = { "tool-a": { x: 1 } };
    const next = setToolValue(bag, "tool-a", "x", 2);
    expect(bag["tool-a"].x).toBe(1);
    expect(next["tool-a"].x).toBe(2);
  });

  it("creates the namespace on first write", () => {
    expect(setToolValue({}, "fresh", "k", true)).toEqual({ fresh: { k: true } });
  });
});
