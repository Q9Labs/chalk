import { useCallback, useEffect, useState } from "react";

import { applyThemeToDocument, resolveThemeFromDocument, subscribeToThemeChanges } from "../../../utils/theme";

interface UseMeetingRoomThemeOptions {
  theme: "light" | "dark" | "system";
}

export function useMeetingRoomTheme({ theme }: UseMeetingRoomThemeOptions) {
  const [isDarkMode, setIsDarkMode] = useState(
    () =>
      resolveThemeFromDocument({
        defaultTheme: theme === "dark" ? "dark" : "light",
        allowSystem: theme === "system",
      }) === "dark",
  );

  const toggleTheme = useCallback(() => {
    setIsDarkMode((prev) => {
      const nextTheme = prev ? "light" : "dark";
      applyThemeToDocument(nextTheme);
      return nextTheme === "dark";
    });
  }, []);

  useEffect(() => {
    if (theme !== "system") {
      applyThemeToDocument(theme);
      setIsDarkMode(theme === "dark");
    } else {
      setIsDarkMode(
        resolveThemeFromDocument({
          defaultTheme: "light",
          allowSystem: true,
        }) === "dark",
      );
    }

    return subscribeToThemeChanges(
      (nextTheme) => {
        setIsDarkMode(nextTheme === "dark");
      },
      {
        defaultTheme: theme === "dark" ? "dark" : "light",
        allowSystem: theme === "system",
      },
    );
  }, [theme]);

  return {
    isDarkMode,
    toggleTheme,
  };
}
