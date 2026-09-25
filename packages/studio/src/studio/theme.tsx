import { Monitor, Moon, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";

export type Theme = "system" | "light" | "dark";

const KEY = "dzb-studio-theme";
const ORDER: Theme[] = ["system", "light", "dark"];

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system"; // storage blocked (private mode, sandboxed iframe): fall back to the system theme
  }
}

const systemDark = (): boolean =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function useTheme(): { theme: Theme; resolved: "light" | "dark"; setTheme(t: Theme): void; next(): Theme } {
  const [theme, setThemeState] = useState<Theme>(stored);
  const resolved = theme === "system" ? (systemDark() ? "dark" : "light") : theme;
  useEffect(() => {
    document.documentElement.classList.toggle("dark", resolved === "dark");
  }, [resolved]);
  const setTheme = useCallback((t: Theme) => {
    setThemeState(t);
    try {
      localStorage.setItem(KEY, t);
    } catch {
      // not persisted; the theme still applies for this session
    }
  }, []);
  const next = () => ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length] ?? "system";
  return { theme, resolved, setTheme, next };
}

export function ThemeToggle() {
  const { theme, setTheme, next } = useTheme();
  const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Theme: ${theme}`}
      onClick={() => setTheme(next())}
    >
      <Icon />
    </Button>
  );
}
