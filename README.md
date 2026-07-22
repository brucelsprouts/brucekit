# brucekit 🧰

**A little launcher for the tiny tools I kept wishing my computer already had.**

You know the moment: you need to grab the text out of a screenshot, or figure out
the exact hex of a color on screen, and you end up hunting for some sketchy website
or a bloated app to do a five-second job. I got tired of that. So I built brucekit —
a fast, dark, keyboard-first popup that lives in the system tray and holds a growing
shelf of my own small quality-of-life utilities.

Press a hotkey, a clean little HUD appears, you search, you launch, it gets out of
your way. That's the whole idea. It ships with two tools I reach for constantly, and
it's built so that adding a third is a five-minute job — drop in a folder and it
shows up.

> This started as a personal "I bet this would actually be useful" weekend project.
> It turned into a genuinely tidy piece of software, so I'm sharing it. 🙂

---

## What it does today

- **⌨️ Hotkey launcher** — one global shortcut (default `Ctrl+Shift+\``) opens a
  searchable grid of tools. Type to filter, `Enter` to launch, `Esc` to dismiss.
  It never steals your taskbar and folds away the instant you're done.
- **🔤 OCR grab** — drag a box over anything on screen and the text inside it lands
  on your clipboard. Runs fully **on-device** using the OCR engine built into
  Windows — no uploads, no accounts, no "free trial."
- **🎨 Color picker + eyedropper** — dial a color in by hand (hex field or R/G/B
  sliders) *or* eyedrop any pixel on your screen, complete with a magnifier loupe.
  Copy it as HEX, RGB, or HSL.
- **📋 ClipStack** — clipboard history (ported from my
  [clipstack](https://github.com/brucelsprouts/clipstack) app). A background
  watcher captures what you copy — plain text, formatted text, and images —
  then you search it, pin favorites, and click to re-copy. Styled text goes
  back with its formatting (or without it, on request), and pictures come back
  as pictures. Rows always show plain text, so the list stays scannable.
- **📶 dcheck** — network dropout monitor (ported from my
  [dcheck](https://github.com/brucelsprouts/dcheck) app). Pings a target on an
  interval and draws a live graph of latency, high-latency spikes, and drops,
  with uptime stats and a persistent log.
- **🔌 Module toggles** — every module can be switched off in Settings. Off means
  gone: hidden from the grid *and* its background work (clipboard watcher,
  pinger) fully stopped — so a leaner brucekit is one checkbox away.

Everything is **local**. No backend, no database, no telemetry, no cloud. Your
config is a plain JSON file on your machine.

## Why it's built the way it is

A couple of principles I cared about, because half the fun was doing it *properly*:

- **Modular from day one.** Every tool is a self-contained module behind one small
  contract. Adding a tool touches exactly zero other files — the registry discovers
  it automatically. No god-file that knows about everything.
- **One bad tool can't sink the ship.** Each tool renders inside its own error
  boundary, native calls return typed `Result`s that surface as a toast, and every
  dispatch is guarded. A tool that throws shows a small "this one broke" card and
  the launcher keeps humming.
- **Exact pixels, no flicker.** Screen tools freeze a snapshot of your monitor
  *first*, then let you select on the static image. The eyedropper becomes a trivial
  pixel lookup and OCR gets the precise crop you meant.
- **Tested where it counts.** The fiddly logic — color math, registry
  loading/dedupe/search, config round-trips, crop-bounds — is covered by unit tests
  on both the TypeScript and Rust sides.

## The stack

Rust does the native heavy lifting (screen capture, OCR, pixel reads, global
hotkey, tray, config); React does the interface. They talk over a small, fully
typed IPC surface.

**Tauri v2 · React · TypeScript · Vite · Rust** — with a black-and-white technical
HUD aesthetic (monospace, hairline borders, corner ticks, one restrained accent).

## Run it yourself

```bash
npm install
npm run tauri dev      # develop with hot reload
npm run tauri build    # build a Windows installer

npm test               # TypeScript unit tests (Vitest)
npm run typecheck      # tsc --noEmit
cd src-tauri && cargo test   # Rust unit tests
```

You'll need [Node.js](https://nodejs.org/) 18+, a stable
[Rust toolchain](https://www.rust-lang.org/tools/install), and the
[Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) (on Windows:
the WebView2 runtime + MSVC build tools).

App icons are generated from a script: `npm run gen:icon`.

## Adding a tool (the fun part)

Create `src/tools/<your-tool>/index.tsx` that default-exports a `ToolModule`.
That's the entire integration step — the registry finds it on next load.

```tsx
import type { ToolModule } from "../types";
import { MyIcon } from "./icon";

const myTool: ToolModule = {
  id: "my-tool",                 // unique, stable
  name: "My tool",
  description: "What it does",
  keywords: ["search", "terms"],
  icon: MyIcon,                  // monochrome SVG, inherits currentColor
  kind: "action",                // "action" = native flow · "panel" = inline UI
  activate: async (ctx) => {
    ctx.closeLauncher();
    ctx.toast("Hello from my tool");
  },
  // panel tools implement render(ctx) instead.
};

export default myTool;
```

`ctx` hands you a typed `invoke`, a `toast`, `closeLauncher`, and a `settings`
handle **namespaced to your tool** — so no tool can read or stomp on another
tool's config. Misbehaving or duplicate modules are logged and skipped at load;
their well-behaved siblings load fine.

## Project layout

```
src/                       React — the interface
  App.tsx                    routes by window label (launcher | overlay)
  core/                      ipc · toast · settings · overlay flow · events · tokens
  launcher/                  search · grid · tiles · panel host · error boundary
  overlay/                   frozen-frame region select (OCR) + eyedropper
  tools/                     the ToolModule contract, auto-registry, and the tools
src-tauri/src/             Rust — the native core
  lib.rs window.rs hotkey.rs tray.rs
  commands/  capture.rs  ocr.rs  color.rs  config.rs  clips.rs  dcheck.rs
docs/brucekit-spec.md      the design this was built from
docs/module-ideas.md       sketches for what's next
```

## What's next

More tiny tools (a JSON formatter and a unit converter are on the list), multi-monitor
capture, and eventually a cross-platform OCR backend behind the existing engine
trait. All folder-drop-ins — which was the whole point.

---

*Built by bruce as a personal project — because I thought it could be useful, and
because building the small thing well is its own reward.*
