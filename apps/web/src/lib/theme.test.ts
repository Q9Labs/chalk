/* @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { readThemePreference, resolveThemeMode, THEME_BOOTSTRAP_SCRIPT } from "./theme";

describe("call appearance before first paint", () => {
  it("keeps the selected call theme on word invite routes", () => {
    expect(resolveThemeMode({ pathname: "/apple-tiger-lamp-river", preference: "dark" })).toBe("dark");
    expect(resolveThemeMode({ pathname: "/apple-tiger-lamp-river", preference: "light" })).toBe("light");
  });
  for (const pathname of ["/space", "/space/team", "/abc-defg-hij", "/ABC-DEFG-HIJ", "/apple-tiger-lamp-river", "/apple-tiger-lamp", "/foo", "/", "/dashboard"]) {
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
