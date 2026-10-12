import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// shadcn themes key off a `.dark` class; mirror the macOS appearance setting onto it.
const scheme = window.matchMedia("(prefers-color-scheme: dark)");
const applyScheme = () => document.documentElement.classList.toggle("dark", scheme.matches);
applyScheme();
scheme.addEventListener("change", applyScheme);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
