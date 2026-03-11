import { createContext, useContext, useEffect, useState } from "react";

type Theme = "dark" | "light" | "nord";

const ThemeContext = createContext<{
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
} | null>(null);

const STORAGE_KEY = "chalk-theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Initialize with 'dark' for server side, then sync with localStorage on mount
  const [theme, setTheme] = useState<Theme>("dark");

  useEffect(() => {
    // Initial mount: read from localStorage
    const saved = localStorage.getItem(STORAGE_KEY) as Theme;
    if (saved && (saved === "dark" || saved === "light" || saved === "nord")) {
      setTheme(saved);
    }
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark", "nord");

    if (theme === "nord") {
      root.classList.add("dark", "nord");
    } else {
      root.classList.add(theme);
    }

    root.style.colorScheme = theme === "light" ? "light" : "dark";
    root.setAttribute("data-chalk-theme", theme);
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = () => {
    setTheme((prev) => {
      if (prev === "dark") return "light";
      if (prev === "light") return "nord";
      return "dark";
    });
  };

  return <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
