export const getPortalChalkTheme = (): string | undefined => {
  if (typeof document === "undefined") {
    return undefined;
  }

  const explicitThemeRoot = document.querySelector<HTMLElement>("[data-chalk-theme]");
  const explicitTheme = explicitThemeRoot?.getAttribute("data-chalk-theme");
  if (explicitTheme === "light" || explicitTheme === "dark") {
    return explicitTheme;
  }

  if (document.documentElement.classList.contains("dark")) {
    return "dark";
  }

  if (document.documentElement.classList.contains("light")) {
    return "light";
  }

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  return undefined;
};
