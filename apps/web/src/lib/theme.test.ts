/* @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";

import { THEME_BOOTSTRAP_SCRIPT, applyThemeMode, isThemedRoute, parseThemePreference, persistThemePreference, readThemePreference, resolveThemeMode } from "./theme";

function stubSystemDark(matches: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  });
}

afterEach(() => {
  document.cookie = "chalk_theme=; path=/; max-age=0";
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("data-chalk-theme");
  document.documentElement.style.colorScheme = "";
  window.history.replaceState(null, "", "/");
});

describe("theme preference", () => {
  it("falls back to the system preference for anything it does not recognise", () => {
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("chalkboard")).toBe("system");
    expect(parseThemePreference(null)).toBe("system");
  });

  it("reads its own cookie past the others", () => {
    expect(readThemePreference("chalk_sidebar_state=false; chalk_theme=light; other=1")).toBe("light");
    expect(readThemePreference("chalk_sidebar_state=false")).toBe("system");
  });

  it("round-trips through the cookie", () => {
    persistThemePreference("dark");
    expect(readThemePreference(document.cookie)).toBe("dark");
  });
});

describe("theme mode", () => {
  it("claims the app chrome and leaves the marketing pages alone", () => {
    expect(isThemedRoute("/home")).toBe(true);
    expect(isThemedRoute("/spaces/design-lab")).toBe(true);
    expect(isThemedRoute("/space/design-lab")).toBe(true);
    expect(isThemedRoute("/")).toBe(false);
    expect(isThemedRoute("/privacy")).toBe(false);
    expect(isThemedRoute("/homepage")).toBe(false);
  });

  it("keeps unthemed routes light whatever the preference says", () => {
    expect(resolveThemeMode({ preference: "dark", pathname: "/", systemMode: "dark" })).toBe("light");
    expect(resolveThemeMode({ preference: "dark", pathname: "/home", systemMode: "light" })).toBe("dark");
    expect(resolveThemeMode({ preference: "system", pathname: "/home", systemMode: "dark" })).toBe("dark");
    expect(resolveThemeMode({ preference: "light", pathname: "/home", systemMode: "dark" })).toBe("light");
  });

  it("writes the flags the stylesheets and chalk portals read", () => {
    applyThemeMode(document.documentElement, "dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-chalk-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyThemeMode(document.documentElement, "light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.getAttribute("data-chalk-theme")).toBe("light");
  });
});

describe("bootstrap script", () => {
  const runBootstrap = () => new Function(THEME_BOOTSTRAP_SCRIPT)();

  it("paints the app dark before React runs when that is the preference", () => {
    stubSystemDark(false);
    document.cookie = "chalk_theme=dark";
    window.history.replaceState(null, "", "/spaces");

    runBootstrap();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.getAttribute("data-chalk-theme")).toBe("dark");
  });

  it("follows the system preference and still spares the landing page", () => {
    stubSystemDark(true);
    window.history.replaceState(null, "", "/home");
    runBootstrap();
    expect(document.documentElement.getAttribute("data-chalk-theme")).toBe("dark");

    window.history.replaceState(null, "", "/");
    runBootstrap();
    expect(document.documentElement.getAttribute("data-chalk-theme")).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
