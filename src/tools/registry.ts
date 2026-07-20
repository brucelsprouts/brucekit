import type { ToolModule } from "./types";

/**
 * Tool registry & auto-registration (spec §5).
 *
 * Tools are discovered by dropping a `tools/<name>/index.tsx` folder in — no
 * edits to any other file. Registration is defensive: each module is validated
 * in isolation; a broken or duplicate module is logged and skipped while every
 * valid sibling still loads.
 */

export type RegistryError = { source: string; reason: string };
export type Registry = { tools: ToolModule[]; errors: RegistryError[] };

function isFn(v: unknown): v is (...a: never[]) => unknown {
  return typeof v === "function";
}

/** Validate one candidate default-export. Pure — the core of the dedupe/load tests. */
export function validateModule(
  candidate: unknown,
): { ok: true; module: ToolModule } | { ok: false; reason: string } {
  if (!candidate || typeof candidate !== "object") {
    return { ok: false, reason: "module has no default export object" };
  }
  const m = candidate as Partial<ToolModule>;

  if (typeof m.id !== "string" || m.id.trim() === "") {
    return { ok: false, reason: "missing string `id`" };
  }
  if (typeof m.name !== "string" || m.name.trim() === "") {
    return { ok: false, reason: `tool "${m.id}" missing string \`name\`` };
  }
  if (!isFn(m.icon)) {
    return { ok: false, reason: `tool "${m.id}" missing \`icon\` component` };
  }
  if (m.kind !== "action" && m.kind !== "panel") {
    return { ok: false, reason: `tool "${m.id}" has invalid \`kind\`` };
  }
  if (m.kind === "action" && !isFn(m.activate)) {
    return { ok: false, reason: `action tool "${m.id}" must define \`activate\`` };
  }
  if (m.kind === "panel" && !isFn(m.render)) {
    return { ok: false, reason: `panel tool "${m.id}" must define \`render\`` };
  }
  return { ok: true, module: m as ToolModule };
}

/**
 * Build a registry from a raw `import.meta.glob` map (path -> module namespace).
 * Pure and injectable so load/dedupe behavior is unit-testable without globbing.
 */
export function buildRegistry(raw: Record<string, unknown>): Registry {
  const tools: ToolModule[] = [];
  const errors: RegistryError[] = [];
  const seen = new Set<string>();

  for (const source of Object.keys(raw).sort()) {
    const ns = raw[source] as { default?: unknown } | undefined;
    const result = validateModule(ns?.default);

    if (!result.ok) {
      errors.push({ source, reason: result.reason });
      console.warn(`[brucekit] skipped tool at ${source}: ${result.reason}`);
      continue;
    }
    if (seen.has(result.module.id)) {
      const reason = `duplicate tool id "${result.module.id}"`;
      errors.push({ source, reason });
      console.warn(`[brucekit] skipped tool at ${source}: ${reason}`);
      continue;
    }
    seen.add(result.module.id);
    tools.push(result.module);
  }

  return { tools, errors };
}

/** Rank tools against a query over name, keywords, description, and id (pure). */
export function searchTools(tools: ToolModule[], query: string): ToolModule[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...tools];

  const scored = tools
    .map((tool) => ({ tool, score: scoreTool(tool, q) }))
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));

  return scored.map((s) => s.tool);
}

/** Hide modules the user toggled off (pure; unit-tested). */
export function filterDisabled(tools: ToolModule[], disabled: string[]): ToolModule[] {
  if (disabled.length === 0) return tools;
  const off = new Set(disabled);
  return tools.filter((tool) => !off.has(tool.id));
}

function scoreTool(tool: ToolModule, q: string): number {
  const name = tool.name.toLowerCase();
  if (name === q) return 100;
  if (name.startsWith(q)) return 80;
  if (name.includes(q)) return 60;
  if ((tool.keywords ?? []).some((k) => k.toLowerCase().includes(q))) return 45;
  if ((tool.description ?? "").toLowerCase().includes(q)) return 30;
  if (tool.id.toLowerCase().includes(q)) return 20;
  return -1;
}

// --- Live singleton: auto-registers every tools/<name>/index.tsx ------------
const globbed = import.meta.glob("./*/index.tsx", { eager: true });
const registry = buildRegistry(globbed);

export function getTools(): ToolModule[] {
  return registry.tools;
}

export function getRegistryErrors(): RegistryError[] {
  return registry.errors;
}

export function search(query: string): ToolModule[] {
  return searchTools(registry.tools, query);
}
