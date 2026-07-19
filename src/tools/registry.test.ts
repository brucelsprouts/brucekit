import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildRegistry, searchTools, validateModule } from "./registry";
import type { ToolModule } from "./types";

const Icon = () => null;

function mod(over: Partial<ToolModule> = {}): ToolModule {
  return {
    id: "sample",
    name: "Sample",
    icon: Icon,
    kind: "action",
    activate: () => {},
    ...over,
  } as ToolModule;
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("validateModule", () => {
  it("accepts a well-formed action tool", () => {
    expect(validateModule(mod()).ok).toBe(true);
  });

  it("rejects a panel tool with no render()", () => {
    const res = validateModule(mod({ kind: "panel", activate: undefined }));
    expect(res.ok).toBe(false);
  });

  it("rejects an action tool with no activate()", () => {
    const res = validateModule(mod({ activate: undefined }));
    expect(res.ok).toBe(false);
  });

  it("rejects missing id / name / icon / kind", () => {
    expect(validateModule(mod({ id: "" })).ok).toBe(false);
    expect(validateModule(mod({ name: "" })).ok).toBe(false);
    expect(validateModule(mod({ icon: undefined as never })).ok).toBe(false);
    expect(validateModule(mod({ kind: "widget" as never })).ok).toBe(false);
    expect(validateModule(null).ok).toBe(false);
  });
});

describe("buildRegistry", () => {
  it("loads every valid sibling", () => {
    const reg = buildRegistry({
      "./a/index.tsx": { default: mod({ id: "a", name: "Alpha" }) },
      "./b/index.tsx": { default: mod({ id: "b", name: "Bravo" }) },
    });
    expect(reg.tools.map((t) => t.id)).toEqual(["a", "b"]);
    expect(reg.errors).toEqual([]);
  });

  it("skips a broken module but keeps its valid siblings", () => {
    const reg = buildRegistry({
      "./good/index.tsx": { default: mod({ id: "good", name: "Good" }) },
      "./broken/index.tsx": { default: mod({ id: "broken", kind: "panel", activate: undefined }) },
    });
    expect(reg.tools.map((t) => t.id)).toEqual(["good"]);
    expect(reg.errors).toHaveLength(1);
    expect(reg.errors[0].source).toBe("./broken/index.tsx");
  });

  it("dedupes by id: first wins, later duplicate is skipped and logged", () => {
    const reg = buildRegistry({
      "./one/index.tsx": { default: mod({ id: "dup", name: "First" }) },
      "./two/index.tsx": { default: mod({ id: "dup", name: "Second" }) },
    });
    expect(reg.tools).toHaveLength(1);
    expect(reg.tools[0].name).toBe("First");
    expect(reg.errors[0].reason).toContain("duplicate");
  });
});

describe("searchTools", () => {
  const tools = [
    mod({ id: "ocr-grab", name: "OCR grab", description: "Copy text from screen", keywords: ["text", "scan"] }),
    mod({ id: "color-picker", name: "Color picker", description: "Sample a pixel", keywords: ["eyedropper", "hex"] }),
  ];

  it("returns all tools for an empty query", () => {
    expect(searchTools(tools, "  ")).toHaveLength(2);
  });

  it("ranks a name prefix match to the top", () => {
    expect(searchTools(tools, "color")[0].id).toBe("color-picker");
  });

  it("matches on keywords and description", () => {
    expect(searchTools(tools, "eyedropper").map((t) => t.id)).toEqual(["color-picker"]);
    expect(searchTools(tools, "from screen").map((t) => t.id)).toEqual(["ocr-grab"]);
  });

  it("filters out non-matches", () => {
    expect(searchTools(tools, "zzzz")).toEqual([]);
  });
});
