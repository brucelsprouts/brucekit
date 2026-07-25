# Module ideas

Sketches for future brucekit modules. Each one has to earn its tile: tiny,
local, keyboard-first, and cheap to keep installed (a disabled module must cost
literally nothing — see the module toggles in Settings).

## runtime — what's been running, and for how long  *(shipped — see src/tools/runtime)*

Shipped first as **pulse**, a system-vitals glance. In use, the thing it kept
getting opened for wasn't "is my computer ok?" — it was "where did the last
four hours go?". So the module was renamed and re-pointed at that question,
and the vitals were dropped entirely rather than demoted: readings nothing
renders are pure waste, and re-enumerating disks every couple of seconds to
throw the result away is exactly the kind of cost this project doesn't accept.

**What:** a ranked list of how long each app has held the foreground this run
(and the previous run, kept across restarts), with total tracked time and
machine uptime up top. That's the whole panel.

**Why it fits:** dcheck answers *"is my connection ok?"*; runtime answers
*"where did my time go?"* Both are questions you ask about something that
happened while you weren't looking, which is why both earn a background
thread and neither earns one when it's switched off.

**Resource contract:**
- One background thread, doing one job: note the foreground app each tick.
- Toggling the module off — or flipping eco mode — stops the thread entirely.
- Uptime is read on demand; there's no reason to sample a counter that only
  ever goes up.
- The app-time ledger persists to `app_usage.json` so the previous run's
  totals survive a restart.

**Renaming note:** `config::rename_module` carries a module's toggle, pin,
hotkey, and settings bag across an id change on load. It runs on every load and
is idempotent, so an old `pulse` config keeps working untouched. Any future
module rename should reuse it rather than stranding the user's settings.

## xpwaste — the pomodoro timer  *(shipped — see src/tools/xpwaste)*

Ported from [xpwaste](https://github.com/brucelsprouts/xpwaste), a PyQt focus
timer, with the Qt chrome and its two themes dropped in favour of the HUD
vocabulary the rest of the app already speaks: a hairline countdown ring, the
segmented control, the stat cards dcheck uses, and a ranked log list built like
runtime's.

**What:** focus / short break / long break with configurable lengths, a cycle
counter that earns a long break every N sessions (nudgeable by hand when real
life happened), start / pause / skip / reset, and a persisted log of *active*
focus time — paused minutes excluded, exactly like the original.

**Why the clock lives in Rust:** this is the module that settled the question.
A focus session is something you start and walk away from, so the countdown has
to survive the launcher being hidden and has to be able to announce itself when
it ends. A webview timer can do neither: a hidden WebView2 window is free to
throttle, and there is nobody to hear a toast in a window nobody is looking at.
So the tick thread owns the clock and the panel renders snapshots of it — the
webview holds no countdown of its own that could drift out of step.

**Resource contract:**
- One background thread ticking at 200 ms — fine enough that start/pause feels
  immediate, and it emits a snapshot only when the displayed second changes.
- Toggling the module off, or flipping eco mode, stops the thread and therefore
  the clock. A stopped clock is a truthful state; a timer that silently drifts
  while its service is dead is not, so the panel says so and Start is disabled.
- Stopping the service banks the focus time already earned rather than
  discarding it.
- The alert is Windows' own `MessageBeep`, or a file of your own played through
  MCI — the same codecs Media Player uses. No audio crate, no bundled sound, no
  licensing question, and a missing file falls back to the beep rather than
  failing silently.

**Colour note:** focus carries the accent, breaks step down to the dim
foreground. No second hue: a break isn't an alarm, it's the same clock doing
something you don't need to watch.

## also on the list

Ordered roughly by how often the gap actually gets hit. Every one of these is a
`panel` tool with no background service unless noted — pinnable to the tray
like anything else.

- **JSON / text scratch** — paste → pretty-print, minify, validate, escape or
  unescape. Pure JS, no service, no network. The most-reached-for utility on
  this list and the cheapest to build.
- **Unit + base converter** — type `12in`, `3kg`, `72f`, `0x1f`, `1<<20` and
  get the answer inline as you type. Pure JS; shares the search box's
  type-to-filter feel.
- **Hash + encode** — drop text or a file, get md5/sha1/sha256, or
  base64/URL/HTML encode-decode either way. Rust side already has the crates;
  pairs naturally with the JSON tool.
- **UUID / password generator** — v4 and v7 uuids, and passphrases with a
  length/charset toggle. One click copies. Trivial to build, used constantly.
- **Timestamp decoder** — paste a unix epoch (s or ms), an ISO string, or a
  Windows FILETIME and see all of them side by side plus "3 hours ago", in
  local and UTC. The natural companion to reading logs.
- **Screenshot annotate** — reuses the existing region-capture overlay, then
  lets you draw an arrow, box, or blur before it hits the clipboard. Higher
  effort, but it builds directly on capture code that already exists.
- **Window snapper** — hotkey-driven halves/thirds/quarters placement on the
  active monitor. Windows-specific and needs care around DPI, so it's the one
  here that genuinely warrants its own spec first.

Deliberately **not** on the list: anything that needs an account, an API key,
or a network round-trip to do its job. That's the line that keeps a tile cheap
to keep installed.
