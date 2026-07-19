import { useToasts } from "../core/toast";

/** Renders the active toast stack for the current window. */
export function Toaster() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;

  return (
    <div className="bk-toaster" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`bk-toast bk-toast--${t.kind}`} role="status">
          <span className="bk-toast__bar" aria-hidden="true" />
          <span className="bk-toast__msg">{t.message}</span>
        </div>
      ))}
    </div>
  );
}
