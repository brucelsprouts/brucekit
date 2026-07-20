import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ToolContext } from "../types";
import { errorMessage, type Rgb } from "../../core/ipc";
import { EV_COLOR_PICKED, launchCapture } from "../../core/overlay";
import { ColorIcon } from "./icon";
import {
  COLOR_FORMATS,
  formatColor,
  hsvToRgb,
  parseHex,
  rgbToHex,
  rgbToHsv,
  type ColorFormat,
} from "./color";

const DEFAULT_COLOR: Rgb = { r: 255, g: 255, b: 255 };
const CHANNELS: Array<keyof Rgb> = ["r", "g", "b"];
/** Recently landed colors kept as one-click swatches. */
const MAX_RECENT = 8;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/**
 * Color picker + eyedropper in one panel (spec §11, extended):
 *  - drag the saturation/value field and hue rail,
 *  - dial a color in by hand (hex field or R/G/B sliders), or
 *  - eyedrop one straight off the screen.
 * Everything feeds the same swatch, format toggle, recents, and clipboard.
 *
 * Hue lives in its own state rather than being derived from RGB on every
 * render: at pure black and along the grey axis the hue of an RGB triple is
 * undefined, so deriving it would snap the rail back to red the moment the
 * field is dragged into a corner. The rail holds its angle instead.
 */
export function ColorPanel({ ctx }: { ctx: ToolContext }) {
  const [format, setFormat] = useState<ColorFormat>("hex");
  const [color, setColor] = useState<Rgb>(DEFAULT_COLOR);
  const [hexDraft, setHexDraft] = useState<string>(rgbToHex(DEFAULT_COLOR));
  const [hue, setHue] = useState<number>(0);
  const [recent, setRecent] = useState<string[]>([]);

  // Refs keep the async listeners and slider handlers off stale closures.
  const formatRef = useRef<ColorFormat>(format);
  const colorRef = useRef<Rgb>(color);
  colorRef.current = color;
  const ready = useRef(false);
  const fieldRef = useRef<HTMLDivElement | null>(null);

  /** Single entry point for a new color: keeps hex field and hue rail in sync. */
  const applyColor = useCallback((rgb: Rgb, keepHue = false) => {
    setColor(rgb);
    setHexDraft(rgbToHex(rgb));
    if (!keepHue) {
      const { s, v } = rgbToHsv(rgb);
      // Only adopt the incoming hue when the color actually has one.
      if (s > 0 && v > 0) setHue(rgbToHsv(rgb).h);
    }
  }, []);

  /** Remember a color the user landed on deliberately (picked, eyedropped, copied). */
  const remember = useCallback((rgb: Rgb) => {
    const hex = rgbToHex(rgb);
    setRecent((prev) => [hex, ...prev.filter((h) => h !== hex)].slice(0, MAX_RECENT));
  }, []);

  // Restore the persisted format, last color, and recents.
  useEffect(() => {
    let alive = true;
    Promise.all([
      ctx.settings.get<ColorFormat>("format", "hex"),
      ctx.settings.get<Rgb>("last", DEFAULT_COLOR),
      ctx.settings.get<string[]>("recent", []),
    ])
      .then(([f, c, r]) => {
        if (!alive) return;
        formatRef.current = f;
        setFormat(f);
        if (c && typeof c.r === "number") applyColor(c);
        if (Array.isArray(r)) setRecent(r.slice(0, MAX_RECENT));
        ready.current = true;
      })
      .catch(() => {
        ready.current = true;
      });
    return () => {
      alive = false;
    };
  }, [ctx, applyColor]);

  // Receive the pixel picked in the overlay eyedropper, copy it, show it.
  useEffect(() => {
    let dispose = () => {};
    listen<Rgb>(EV_COLOR_PICKED, async (event) => {
      const rgb = event.payload;
      applyColor(rgb);
      remember(rgb);
      const text = formatColor(rgb, formatRef.current);
      await copyToClipboard(text);
      ctx.toast(`Picked ${text}`, { kind: "success" });
    })
      .then((un) => {
        dispose = un;
      })
      .catch(() => {});
    return () => dispose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, applyColor, remember]);

  // Persist the current color (debounced so drags don't spam the store).
  useEffect(() => {
    if (!ready.current) return;
    const t = window.setTimeout(() => {
      void ctx.settings.set("last", color).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [color, ctx]);

  useEffect(() => {
    if (!ready.current) return;
    void ctx.settings.set("recent", recent).catch(() => {});
  }, [recent, ctx]);

  async function copyToClipboard(text: string): Promise<void> {
    try {
      await writeText(text);
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function changeFormat(next: ColorFormat) {
    formatRef.current = next;
    setFormat(next);
    try {
      await ctx.settings.set("format", next);
    } catch {
      /* non-fatal: the format still applies this session */
    }
  }

  function setChannel(ch: keyof Rgb, value: number) {
    applyColor({ ...colorRef.current, [ch]: value });
  }

  function onHexInput(value: string) {
    setHexDraft(value);
    const parsed = parseHex(value);
    if (parsed) applyColor(parsed);
  }

  /** Field drag: pointer position → saturation (x) and value (y) at the held hue. */
  function onFieldPointer(e: React.PointerEvent<HTMLDivElement>) {
    const box = fieldRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const s = clamp01((e.clientX - box.left) / box.width);
    const v = 1 - clamp01((e.clientY - box.top) / box.height);
    applyColor(hsvToRgb({ h: hue, s, v }), true);
  }

  function onFieldDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    onFieldPointer(e);
  }

  function onFieldMove(e: React.PointerEvent<HTMLDivElement>) {
    // Buttons is a bitmask; 1 = primary held. Pointer capture keeps the drag
    // alive even when it leaves the field.
    if (e.buttons & 1) onFieldPointer(e);
  }

  function onHueChange(next: number) {
    setHue(next);
    const { s, v } = rgbToHsv(colorRef.current);
    applyColor(hsvToRgb({ h: next, s, v }), true);
  }

  async function eyedrop() {
    try {
      // Keep the panel mounted so it receives the picked color on return.
      await launchCapture("color");
    } catch (err) {
      ctx.toast(errorMessage(err), { kind: "error" });
    }
  }

  async function copyCurrent() {
    const text = formatColor(color, format);
    await copyToClipboard(text);
    remember(color);
    ctx.toast(`Copied ${text}`, { kind: "success" });
  }

  const value = formatColor(color, format);
  const hex = rgbToHex(color);
  const { s: sat, v: val } = rgbToHsv(color);
  const hueHex = rgbToHex(hsvToRgb({ h: hue, s: 1, v: 1 }));

  return (
    <div className="bk-colorpanel">
      <div className="bk-colorpanel__readout">
        <div
          className="bk-swatch bk-swatch--lg"
          style={{ background: hex }}
          aria-label="Current color swatch"
        />
        <div className="bk-colorpanel__value">
          <span className="bk-label">VALUE</span>
          <code className="bk-mono-value">{value}</code>
          <div className="bk-seg" role="group" aria-label="Color format">
            {COLOR_FORMATS.map((f) => (
              <button
                key={f}
                type="button"
                className={`bk-seg__btn ${f === format ? "is-active" : ""}`}
                aria-pressed={f === format}
                onClick={() => changeFormat(f)}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        {/* Eyedrop is this module's headline verb, so it wears the same action
            treatment as OCR's Scan rather than sitting level with Copy. */}
        <div className="bk-colorpanel__actions">
          <button
            type="button"
            className="bk-action bk-action--inline"
            onClick={eyedrop}
            title="Pick a pixel from the screen"
          >
            <ColorIcon size={18} />
            <span>Eyedrop</span>
          </button>
          <button type="button" className="bk-btn bk-btn--accent" onClick={copyCurrent}>
            Copy
          </button>
        </div>
      </div>

      <div className="bk-picker">
        <div
          className="bk-svfield"
          ref={fieldRef}
          style={{ background: hueHex }}
          onPointerDown={onFieldDown}
          onPointerMove={onFieldMove}
          role="application"
          aria-label="Saturation and brightness field"
        >
          <span className="bk-svfield__white" aria-hidden="true" />
          <span className="bk-svfield__black" aria-hidden="true" />
          <span
            className="bk-svfield__puck"
            aria-hidden="true"
            style={{
              left: `${sat * 100}%`,
              top: `${(1 - val) * 100}%`,
              background: hex,
            }}
          />
        </div>

        <div className="bk-slider bk-slider--hue">
          <span className="bk-slider__label">H</span>
          <input
            type="range"
            min={0}
            max={359}
            value={Math.round(hue)}
            onChange={(e) => onHueChange(Number(e.target.value))}
            aria-label="Hue"
          />
          <span className="bk-slider__val">{Math.round(hue)}°</span>
        </div>

        <div className="bk-picker__controls">
          <div className="bk-sliders">
          {CHANNELS.map((ch) => (
            <div className="bk-slider" key={ch}>
              <span className="bk-slider__label">{ch.toUpperCase()}</span>
              <input
                type="range"
                min={0}
                max={255}
                value={color[ch]}
                onChange={(e) => setChannel(ch, Number(e.target.value))}
                aria-label={`${ch.toUpperCase()} channel`}
                // The track previews the channel it controls: sliding R shows
                // exactly which reds are reachable from the current G and B.
                style={{
                  ["--bk-track-from" as string]: rgbToHex({ ...color, [ch]: 0 }),
                  ["--bk-track-to" as string]: rgbToHex({ ...color, [ch]: 255 }),
                }}
              />
                <span className="bk-slider__val">{color[ch]}</span>
              </div>
            ))}
          </div>

          <label className="bk-hexfield">
            <span className="bk-label">HEX</span>
            <input
              className="bk-hexinput"
              type="text"
              value={hexDraft}
              onChange={(e) => onHexInput(e.target.value)}
              spellCheck={false}
              autoComplete="off"
              aria-label="Hex color"
            />
          </label>
        </div>
      </div>

      {recent.length > 0 && (
        <div className="bk-recents">
          <span className="bk-label">RECENT</span>
          <div className="bk-recents__row">
            {recent.map((h) => (
              <button
                key={h}
                type="button"
                className={`bk-recents__swatch ${h === hex ? "is-active" : ""}`}
                style={{ background: h }}
                onClick={() => {
                  const rgb = parseHex(h);
                  if (rgb) applyColor(rgb);
                }}
                aria-label={`Use ${h}`}
                title={h}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
