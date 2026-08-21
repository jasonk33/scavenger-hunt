"use client";

import { useEffect, useState } from "react";

export type Theme = "auto" | "light" | "dark";

const KEY = "sh.theme";
const NEXT: Record<Theme, Theme> = { auto: "light", light: "dark", dark: "auto" };
const LABEL: Record<Theme, string> = { auto: "Auto", light: "Light", dark: "Dark" };
const ICON: Record<Theme, string> = { auto: "◐", light: "☀", dark: "☾" };

/**
 * Runs before first paint, inlined in <head>, to stop a white flash on a dark
 * phone. Kept as a string so it can be injected with dangerouslySetInnerHTML --
 * a React effect runs after paint, which is exactly too late.
 */
export const THEME_SCRIPT = `
(function(){try{
  var t = localStorage.getItem(${JSON.stringify(KEY)});
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
}catch(e){}})();
`;

export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("auto");

  useEffect(() => {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark") setTheme(saved);
  }, []);

  const cycle = () => {
    const next = NEXT[theme];
    setTheme(next);
    if (next === "auto") {
      localStorage.removeItem(KEY);
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem(KEY, next);
      document.documentElement.dataset.theme = next;
    }
  };

  return (
    <button
      className="theme-btn"
      onClick={cycle}
      title={`Theme: ${LABEL[theme]} — tap for ${LABEL[NEXT[theme]]}`}
      aria-label={`Theme: ${LABEL[theme]}. Tap to switch to ${LABEL[NEXT[theme]]}.`}
    >
      {ICON[theme]}
    </button>
  );
}
