export const THEME_KEY = "armada.theme.v1";
export const FONT_SCALE_KEY = "armada.fontScale.v1";
export type ThemeName = "dark" | "light";
export type FontScale = "normal" | "large" | "xlarge";

export function loadTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch { /* ignore */ }
  return "dark";
}

export function saveTheme(theme: ThemeName): void {
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
}

export function applyTheme(theme: ThemeName): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

export function otherTheme(theme: ThemeName): ThemeName {
  return theme === "dark" ? "light" : "dark";
}

export function loadFontScale(): FontScale {
  try {
    const raw = localStorage.getItem(FONT_SCALE_KEY);
    if (raw === "normal" || raw === "large" || raw === "xlarge") return raw;
  } catch { /* ignore */ }
  return "normal";
}

export function saveFontScale(scale: FontScale): void {
  try { localStorage.setItem(FONT_SCALE_KEY, scale); } catch { /* ignore */ }
}

export function zoomForFontScale(scale: FontScale): number {
  if (scale === "large") return 1.25;
  if (scale === "xlarge") return 1.5;
  return 1;
}

export function applyFontScale(scale: FontScale): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.fontScale = scale;
}
