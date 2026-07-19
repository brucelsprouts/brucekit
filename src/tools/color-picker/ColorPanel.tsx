import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { ToolContext } from "../types";
import { errorMessage, type Rgb } from "../../core/ipc";
import { EV_COLOR_PICKED, launchCapture } from "../../core/overlay";
import {
  COLOR_FORMATS,
  formatColor,
  parseHex,
  rgbToHex,
  type ColorFormat,
} from "./color";

const DEFAULT_COLOR: Rgb = { r: 77, g: 224, b: 176 };
const CHANNELS: Array<keyof Rgb> = ["r", "g", "b"];

/**
 * Color picker + eyedropper in one panel (spec §11, extended):
 *  - dial a color in by hand (hex field or R/G/B sliders), or
 *  - eyedrop one straight off the screen.
 * Both feed the same swatch/value, format toggle, and clipboard.
 */
export function ColorPanel({ ctx }: { ctx: ToolContext }) {
  const [format, setFormat] = useState<ColorFormat>("hex");
  const [color, setColor] = useState<Rgb>(DEFAULT_COLOR);
  const [hexDraft, setHexDraft] = useState<string>(rgbToHex(DEFAULT_COLOR));

  // Refs keep the async listeners and slider handlers off stale closures.
  const formatRef = useRef<ColorFormat>(format);
  const colorRef = useRef<Rgb>(color);
  colorRef.current = color;
  const ready = useRef(false);

  /** Single entry point for a new color: keeps the hex field in sync. */
  function applyColor(rgb: Rgb) {
    setColor(rgb);
    setHexDraft(rgbToHex(rgb));
  }

  // Restore the persisted format + last color.
  useEffect(() => {
    let alive = true;
    Promise.all([
      ctx.settings.get<ColorFormat>("format", "hex"),
      ctx.settings.get<Rgb>("last", DEFAULT_COLOR),
    ])
      .then(([f, c]) => {
        if (!alive) return;
        formatRef.current = f;
        setFormat(f);
        if (c && typeof c.r === "number") applyColor(c);
        ready.current = true;
      })
      .catch(() => {
        ready.current = true;
      });
    return () => {
      alive = false;
    };
  }, [ctx]);

  // Receive the pixel picked in the overlay eyedropper, copy it, show it.
  useEffect(() => {
    let dispose = () => {};
    listen<Rgb>(EV_COLOR_PICKED, async (event) => {
      const rgb = event.payload;
      applyColor(rgb);
      const text = formatColor(rgb, formatRef.current);
      await copyToClipboard(text);
      ctx.toast(`Picked ${text}`, { kind: "success" });
    })
      .then((un) => {
        dispose = un;
      })
      .catch(() => {});
    return () => dispose();
  }, [ctx]);

  // Persist the current color (debounced so slider drags don't spam the store).
  useEffect(() => {
    if (!ready.current) return;
    const t = window.setTimeout(() => {
      void ctx.settings.set("last", color).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [color, ctx]);

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
    if (parsed) setColor(parsed);
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
    ctx.toast(`Copied ${text}`, { kind: "success" });
  }

  const value = formatColor(color, format);

  return (
    <div className="bk-colorpanel">
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

      <div className="bk-colorpanel__readout">
        <div
          className="bk-swatch"
          style={{ background: rgbToHex(color) }}
          aria-label="Current color swatch"
        />
        <div className="bk-colorpanel__value">
          <span className="bk-label">VALUE</span>
          <code className="bk-mono-value">{value}</code>
        </div>
      </div>

      <div className="bk-picker">
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
              />
              <span className="bk-slider__val">{color[ch]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="bk-colorpanel__actions">
        <button type="button" className="bk-btn" onClick={copyCurrent}>
          Copy
        </button>
        <button type="button" className="bk-btn bk-btn--accent" onClick={eyedrop}>
          Eyedrop
        </button>
      </div>
    </div>
  );
}
