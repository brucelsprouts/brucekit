import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles/global.css";

// StrictMode is intentionally omitted: its dev double-invoke would fire the
// native capture/OCR flows twice.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);
