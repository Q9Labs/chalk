export type ThemeMode = "light" | "dark";

const THEME_ATTRIBUTE_NAMES = ["data-chalk-theme", "data-theme"] as const;
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

const normalizeTheme = (value?: string | null): ThemeMode | null => {
  if (value === "dark" || value === "light") {
    return value;
  }
  return null;
};

const resolveThemeFromElement = (element: Element | null): ThemeMode | null => {
  if (!element) return null;

  for (const attributeName of THEME_ATTRIBUTE_NAMES) {
    const attributeTheme = normalizeTheme(element.getAttribute(attributeName));
    if (attributeTheme) return attributeTheme;
  }

  const classList = element.classList;
  if (classList.contains("dark")) return "dark";
  if (classList.contains("light")) return "light";
  return null;
};

interface ResolveThemeOptions {
  defaultTheme?: ThemeMode;
  allowSystem?: boolean;
}

export const resolveThemeFromDocument = ({ defaultTheme = "light", allowSystem = true }: ResolveThemeOptions = {}): ThemeMode => {
  if (typeof document === "undefined") return defaultTheme;

  const explicitTheme = resolveThemeFromElement(document.documentElement) ?? resolveThemeFromElement(document.body);
  if (explicitTheme) return explicitTheme;

  if (allowSystem && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia(SYSTEM_DARK_QUERY).matches ? "dark" : "light";
  }

  return defaultTheme;
};

export const resolvePortalThemeFromDocument = ({ defaultTheme = "light", allowSystem = true }: ResolveThemeOptions = {}): ThemeMode => {
  if (typeof document === "undefined") return defaultTheme;

  const portalTheme = normalizeTheme(document.querySelector<HTMLElement>("[data-chalk-theme]")?.getAttribute("data-chalk-theme"));
  if (portalTheme) return portalTheme;

  return resolveThemeFromDocument({ defaultTheme, allowSystem });
};

export const applyThemeToDocument = (theme: ThemeMode): void => {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.classList.remove("light", "dark");
  root.classList.add(theme);

  for (const element of [root, document.body]) {
    if (!element) continue;
    for (const attributeName of THEME_ATTRIBUTE_NAMES) {
      if (element.hasAttribute(attributeName)) {
        element.setAttribute(attributeName, theme);
      }
    }
  }
};

interface ThemeSubscriptionOptions extends ResolveThemeOptions {
  attributes?: readonly string[];
}

export const subscribeToThemeChanges = (onThemeChange: (theme: ThemeMode) => void, { defaultTheme = "light", allowSystem = true, attributes = ["class", ...THEME_ATTRIBUTE_NAMES] }: ThemeSubscriptionOptions = {}): (() => void) => {
  if (typeof document === "undefined") return () => {};

  let lastTheme = resolveThemeFromDocument({ defaultTheme, allowSystem });
  const emitTheme = () => {
    lastTheme = resolveThemeFromDocument({ defaultTheme, allowSystem });
    onThemeChange(lastTheme);
  };
  const emitThemeIfChanged = () => {
    const nextTheme = resolveThemeFromDocument({ defaultTheme, allowSystem });
    if (nextTheme !== lastTheme) {
      lastTheme = nextTheme;
      onThemeChange(nextTheme);
    }
  };

  emitTheme();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === "attributes" && attributes.includes(mutation.attributeName ?? "")) {
        emitTheme();
        return;
      }
    }
  });

  const observerOptions: MutationObserverInit = {
    attributes: true,
    attributeFilter: [...attributes],
  };

  observer.observe(document.documentElement, observerOptions);
  if (document.body) {
    observer.observe(document.body, observerOptions);
  }

  const intervalId = window.setInterval(emitThemeIfChanged, 250);

  let mediaQueryList: MediaQueryList | null = null;
  let removeSystemListener = () => {};
  if (allowSystem && typeof window !== "undefined" && typeof window.matchMedia === "function") {
    mediaQueryList = window.matchMedia(SYSTEM_DARK_QUERY);
    const handleChange = () => emitTheme();
    if (typeof mediaQueryList.addEventListener === "function") {
      mediaQueryList.addEventListener("change", handleChange);
      removeSystemListener = () => mediaQueryList?.removeEventListener("change", handleChange);
    } else if (typeof mediaQueryList.addListener === "function") {
      mediaQueryList.addListener(handleChange);
      removeSystemListener = () => mediaQueryList?.removeListener(handleChange);
    }
  }

  return () => {
    observer.disconnect();
    removeSystemListener();
    window.clearInterval(intervalId);
  };
};
