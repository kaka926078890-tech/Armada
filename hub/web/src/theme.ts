export const THEME_KEY = "armada.theme.v1";
export type ThemeName = "dark" | "light";

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
