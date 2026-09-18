import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyFontScale, applyTheme, loadFontScale, loadTheme } from "./theme";
import "./index.css";

applyTheme(loadTheme());
applyFontScale(loadFontScale());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
