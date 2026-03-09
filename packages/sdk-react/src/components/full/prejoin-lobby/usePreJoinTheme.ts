import { useCallback, useEffect, useState } from "react";

import { applyThemeToDocument, resolveThemeFromDocument, subscribeToThemeChanges } from "../../../utils/theme";

export interface UsePreJoinThemeParams {
  initialTheme: "light" | "dark";
}

export interface UsePreJoinThemeReturn {
  isDarkMode: boolean;
  toggleTheme: () => void;
}

export function usePreJoinTheme({ initialTheme }: UsePreJoinThemeParams): UsePreJoinThemeReturn {
  const [isDarkMode, setIsDarkMode] = useState(
    () =>
      resolveThemeFromDocument({
        defaultTheme: initialTheme,
        allowSystem: true,
      }) === "dark",
  );

  useEffect(() => {
    return subscribeToThemeChanges(
      (theme) => {
        setIsDarkMode(theme === "dark");
      },
      {
        defaultTheme: initialTheme,
        allowSystem: true,
      },
    );
  }, [initialTheme]);

  const toggleTheme = useCallback(() => {
    setIsDarkMode((previous) => {
      const nextTheme = previous ? "light" : "dark";
      applyThemeToDocument(nextTheme);
      return nextTheme === "dark";
    });
  }, []);

  return { isDarkMode, toggleTheme };
}
