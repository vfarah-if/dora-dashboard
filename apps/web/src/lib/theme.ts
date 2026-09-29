import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export const THEME_STORAGE_KEY = "delivery-metrics-theme";

function readStored(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function writeStored(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable in a private window; the choice then lasts for this page only.
  }
}

function systemTheme(): Theme {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** The effective theme, starting from a stored choice or the system setting, and a toggle that persists it. */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readStored() ?? systemTheme());

  useEffect(() => {
    if (readStored()) document.documentElement.dataset.theme = theme;
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      writeStored(next);
      document.documentElement.dataset.theme = next;
      return next;
    });
  }, []);

  return { theme, toggle };
}
