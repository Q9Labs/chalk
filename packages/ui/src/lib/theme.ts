export type ThemeMode = "light" | "dark";

const THEME_ATTRIBUTE_NAMES = ["data-chalk-theme", "data-theme"] as const;
const THEME_CLASS_NAMES = ["dark", "light"] as const;
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

const normalizeTheme = (value?: string | null): ThemeMode | null => {
  if (value === "dark" || value === "light") {
    return value;
  }
  return null;
};

const resolveThemeFromElement = (element: Element | null): ThemeMode | null => {
  if (!element) return null;

  const attributeTheme = THEME_ATTRIBUTE_NAMES.map((attributeName) => normalizeTheme(element.getAttribute(attributeName))).find((theme) => theme !== null);
  const classTheme = THEME_CLASS_NAMES.find((theme) => element.classList.contains(theme));
  return attributeTheme ?? classTheme ?? null;
};

interface ResolveThemeOptions {
  defaultTheme?: ThemeMode;
  allowSystem?: boolean;
}

const resolveSystemTheme = (): ThemeMode | null => {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches ? "dark" : "light";
};

const resolveExplicitThemeFromDocument = (): ThemeMode | null => {
  if (typeof document === "undefined") return null;
  return resolveThemeFromElement(document.documentElement) ?? resolveThemeFromElement(document.body);
};

const resolveFallbackTheme = ({ defaultTheme, allowSystem }: Required<ResolveThemeOptions>): ThemeMode => {
  if (!allowSystem) return defaultTheme;

  return resolveSystemTheme() ?? defaultTheme;
};

const resolveThemeFromDocument = ({ defaultTheme = "light", allowSystem = true }: ResolveThemeOptions = {}): ThemeMode => {
  const explicitTheme = resolveExplicitThemeFromDocument();
  return explicitTheme ?? resolveFallbackTheme({ defaultTheme, allowSystem });
};

export const resolvePortalThemeFromDocument = ({ defaultTheme = "light", allowSystem = true }: ResolveThemeOptions = {}): ThemeMode => {
  if (typeof document === "undefined") return defaultTheme;

  const portalTheme = normalizeTheme(document.querySelector<HTMLElement>("[data-chalk-theme]")?.getAttribute("data-chalk-theme"));
  if (portalTheme) return portalTheme;

  return resolveThemeFromDocument({ defaultTheme, allowSystem });
};
