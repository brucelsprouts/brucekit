import { getCurrentWindow } from "@tauri-apps/api/window";
import { ToastProvider } from "./core/toast";
import { Toaster } from "./components/Toast";
import { Launcher } from "./launcher/Launcher";
import { Overlay } from "./overlay/Overlay";

/** One Vite app, routed by window label (spec §3). */
function currentLabel(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    // Outside a Tauri webview (e.g. plain browser preview) — default to launcher.
    return "launcher";
  }
}

export function App() {
  const label = currentLabel();
  return (
    <ToastProvider>
      {label === "overlay" ? <Overlay /> : <Launcher />}
      <Toaster />
    </ToastProvider>
  );
}
