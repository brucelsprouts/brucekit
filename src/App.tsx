import { getCurrentWindow } from "@tauri-apps/api/window";
import { ToastProvider } from "./core/toast";
import { Toaster } from "./components/Toast";
import { Launcher } from "./launcher/Launcher";
import { Overlay } from "./overlay/Overlay";
import { XpwasteWindow } from "./tools/xpwaste/XpwasteWindow";

/** One Vite app, routed by window label (spec §3). */
function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Outside a Tauri webview (e.g. plain browser preview) — default to the
    // launcher, unless the URL names a window (`?window=xpwaste`), which is how
    // the standalone windows are previewed and tested without Tauri.
    return new URLSearchParams(window.location.search).get("window") ?? "launcher";
  }
}

export function App() {
  const label = currentLabel();
  return (
    <ToastProvider>
      {label === "overlay" ? (
        <Overlay />
      ) : label === "xpwaste" ? (
        <XpwasteWindow />
      ) : (
        <Launcher />
      )}
      <Toaster />
    </ToastProvider>
  );
}
