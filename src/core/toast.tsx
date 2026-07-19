import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  useRef,
  type ReactNode,
} from "react";

export type ToastKind = "info" | "success" | "error";

export type ToastOptions = {
  kind?: ToastKind;
  /** Time-to-live in ms before auto-dismiss. */
  ttl?: number;
};

export type Toast = {
  id: number;
  message: string;
  kind: ToastKind;
  ttl: number;
};

export type ToastAction =
  | { type: "add"; toast: Toast }
  | { type: "dismiss"; id: number }
  | { type: "clear" };

const MAX_TOASTS = 4;

/**
 * Pure toast reducer (unit-tested, spec §15). Newest toast is last; the list is
 * capped so a chatty tool can't fill the screen.
 */
export function toastReducer(state: Toast[], action: ToastAction): Toast[] {
  switch (action.type) {
    case "add": {
      const next = [...state, action.toast];
      return next.length > MAX_TOASTS ? next.slice(next.length - MAX_TOASTS) : next;
    }
    case "dismiss":
      return state.filter((t) => t.id !== action.id);
    case "clear":
      return [];
    default:
      return state;
  }
}

/**
 * Decoupled pub/sub so any code (tools, overlay flows, tray handlers) can raise a
 * toast without a React ref. The nearest `ToastProvider` subscribes and renders.
 */
type Emission = { message: string; opts?: ToastOptions };
type Listener = (e: Emission) => void;

class ToastBus {
  private listeners = new Set<Listener>();
  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(message: string, opts?: ToastOptions): void {
    for (const fn of this.listeners) fn({ message, opts });
  }
}

export const toastBus = new ToastBus();

/** Imperative entry point used by tools and native-flow callbacks. */
export function toast(message: string, opts?: ToastOptions): void {
  toastBus.emit(message, opts);
}

const ToastContext = createContext<Toast[]>([]);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, dispatch] = useReducer(toastReducer, []);
  const seq = useRef(0);

  useEffect(() => {
    return toastBus.subscribe(({ message, opts }) => {
      const id = ++seq.current;
      const ttl = opts?.ttl ?? 2600;
      dispatch({ type: "add", toast: { id, message, kind: opts?.kind ?? "info", ttl } });
      window.setTimeout(() => dispatch({ type: "dismiss", id }), ttl);
    });
  }, []);

  return <ToastContext.Provider value={toasts}>{children}</ToastContext.Provider>;
}

export function useToasts(): Toast[] {
  return useContext(ToastContext);
}
