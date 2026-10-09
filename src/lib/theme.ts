import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "musegod.theme";
const THEME_COLOR: Record<Theme, string> = { light: "#fbf7ee", dark: "#13110c" };
const listeners = new Set<() => void>();

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch { return null; }
}
function system(): Theme {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
export function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  const explicit = document.documentElement.dataset.theme;
  return explicit === "light" || explicit === "dark" ? explicit : stored() ?? system();
}
function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
  listeners.forEach((listener) => listener());
}
// CSS follows prefers-color-scheme until a choice exists; an explicit choice
// is stored per browser and pinned on the root element.
export function initTheme() {
  if (typeof document === "undefined") return;
  apply(stored() ?? system());
  if (typeof matchMedia === "function") matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (!stored()) apply(system());
  });
}
export function setTheme(theme: Theme) {
  try { localStorage.setItem(KEY, theme); } catch { /* The choice still applies to this page. */ }
  apply(theme);
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function useTheme() {
  const theme = useSyncExternalStore(subscribe, currentTheme, () => "light" as Theme);
  return { theme, toggle: () => setTheme(theme === "dark" ? "light" : "dark") };
}
