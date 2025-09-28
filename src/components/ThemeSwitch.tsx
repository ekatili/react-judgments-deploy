"use client";

import React from "react";

const THEMES = [
  "light",
  "dark",
  "sepia",
  "solarized-light",
  "solarized-dark",
  "nord",
  "forest",
  "rose",
  "ocean",
  "high-contrast",
] as const;

type ThemeName = typeof THEMES[number];
const STORAGE_KEY = "theme";
const COOKIE = "theme";

export default function ThemeSwitch() {
  const [theme, setTheme] = React.useState<ThemeName>("light");

  // Initialize from the SSR-rendered attribute to avoid hydration mismatch
  React.useEffect(() => {
    const initial = (document.documentElement.dataset.theme as ThemeName) || "light";
    setTheme(initial);

    // Keep localStorage in sync (optional)
    try {
      const saved = (localStorage.getItem(STORAGE_KEY) as ThemeName | null) || null;
      if (!saved || saved !== initial) localStorage.setItem(STORAGE_KEY, initial);
    } catch {
      /* ignore */
    }
  }, []);

  const onChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value as ThemeName;
    setTheme(next);

    // Apply immediately in the DOM
    document.documentElement.dataset.theme = next;

    // Persist for future SSR and reloads
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    // 1-year cookie, Lax is fine
    document.cookie = `${COOKIE}=${encodeURIComponent(next)}; path=/; max-age=31536000; samesite=lax`;
  };

  return (
    <label className="inline-flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-sm shadow-sm">
      <span className="text-[var(--foreground)]">Theme</span>
      <select
        value={theme}
        onChange={onChange}
        className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:border-[var(--accent)]"
        aria-label="Theme"
      >
        {THEMES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}
