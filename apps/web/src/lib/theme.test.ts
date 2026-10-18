/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { readThemePreference, resolveThemeMode, THEME_BOOTSTRAP_SCRIPT } from "./theme";

describe("call appearance before first paint", () => {
  for (const pathname of ["/space", "/space/team", "/", "/dashboard"]) {
    for (const cookie of ["", "chalk_theme=light", "chalk_theme=dark", "chalk_theme=system", "chalk_theme=%"]) {
      it(`${pathname} with ${cookie || "no preference"} matches the synchronous head bootstrap`, () => {
        document.cookie = "chalk_theme=; max-age=0; path=/";
        if (cookie) document.cookie = `${cookie}; path=/`;
        window.history.replaceState({}, "", pathname);
        const expected = resolveThemeMode({ pathname, preference: readThemePreference(document.cookie) });
        window.eval(THEME_BOOTSTRAP_SCRIPT);
        expect(document.documentElement.dataset.chalkTheme).toBe(expected);
        expect(document.documentElement.classList.contains("dark")).toBe(expected === "dark");
        expect(document.documentElement.style.colorScheme).toBe(expected);
      });
    }
  }
});
