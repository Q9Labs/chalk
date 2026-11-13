import { resolveThemeFromDocument, type ResolveThemeOptions, type ThemeMode } from "@q9labsai/chalk-ui";

export { resolvePortalThemeFromDocument, resolveThemeFromDocument, type ThemeMode } from "@q9labsai/chalk-ui";

const THEME_ATTRIBUTE_NAMES = ["data-chalk-theme", "data-theme"] as const;
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

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
