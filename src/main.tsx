import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { watchTitleBarDoubleClick } from "./components/TitleBar";
import { initTheme } from "./settings/theme";
import "./index.css";
import "./tags/colors.css";

// Light or dark, from the Appearance setting (System follows the OS live). index.html already
// applied the last value used before the first paint; this takes over from there.
initTheme();
// macOS: double-clicking the top row follows the system setting (zoom, minimize or nothing).
watchTitleBarDoubleClick();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
