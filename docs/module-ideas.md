# Module ideas

Sketches for future brucekit modules. Each one has to earn its tile: tiny,
local, keyboard-first, and cheap to keep installed (a disabled module must cost
literally nothing — see the module toggles in Settings).

## pulse — system vitals glance  *(proposed next)*

**What:** hit the hotkey, open **pulse**, and get a one-screen read of the
machine: CPU load, memory pressure, disk fill, battery + charge state, and
network up/down — each with a small trailing sparkline in the same canvas style
as dcheck's ping graph.

**Why it fits:** dcheck answers *"is my connection ok?"*; pulse answers *"is my
computer ok?"* — the natural sibling. It also completes the resource story that
motivated module toggles: the tool you open to see **why** the fans are
spinning should never be part of the reason they spin.

**Resource contract (the important part):**
- **Zero background work.** Unlike clipstack/dcheck, pulse has no service
  thread — it samples only while its panel is on screen (1 Hz), and stops the
  instant you leave it.
- Toggling it off just hides the tile — nothing else to stop.

**How:**
- Rust: a `pulse_snapshot` command returning one typed struct
  (`cpuPct, memUsed, memTotal, diskUsed, diskTotal, batteryPct, charging,
  netRxBps, netTxBps`). The `sysinfo` crate covers all of it cross-platform,
  and it's already in the dependency tree (pulled in by xcap).
- Frontend: a `panel` tool that polls the command on a 1 s interval while
  mounted, keeps the last ~60 samples in memory for sparklines, and renders
  the same stat-tile + canvas layout dcheck uses.
- Settings (namespaced, as always): sample rate, which rows to show.

**Effort:** small — one Rust command, one panel, no service, no migrations.

## also on the list

- **JSON formatter** — paste → pretty-print/minify/validate (panel, pure JS).
- **Unit converter** — `12in`, `3kg`, `72f`… inline result as you type.
