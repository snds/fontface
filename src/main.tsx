import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { watchTitleBarDoubleClick } from "./components/TitleBar";
import { initTheme } from "./settings/theme";
import { initTranslucency } from "./settings/translucent";
import "./index.css";
import "./tags/colors.css";

// Light or dark, from the Appearance setting (System follows the OS live). index.html already
// applied the last value used before the first paint; this takes over from there.
initTheme();
// The see-through sidebar follows the back end (Settings › General › Translucent sidebar).
initTranslucency();
// macOS: double-clicking the top row follows the system setting (zoom, minimize or nothing).
watchTitleBarDoubleClick();
// The window never scrolls (index.css), but code can still scroll a hidden page, say focus()
// on something past its edge. Put it straight back.
window.addEventListener("scroll", () => {
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
