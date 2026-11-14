// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { THEME_BOOTSTRAP_SCRIPT } from "./theme";

afterEach(() => {
  document.documentElement.removeAttribute("data-call-boot");
  window.history.replaceState(null, "", "/");
  document.cookie = "chalk_theme=; max-age=0; path=/";
});

const bootFor = (path: string) => {
  window.history.replaceState(null, "", path);
  document.documentElement.removeAttribute("data-call-boot");
  // The script is our own constant, the same one the HTML shell inlines in its head.
  new Function(THEME_BOOTSTRAP_SCRIPT)();
  return document.documentElement.getAttribute("data-call-boot");
};

it("paints the call boot frame on invite, Space and dashboard join paths only", () => {
  expect(bootFor("/blue-river-stone")).toBe("dark");
  expect(bootFor("/space/q9-team")).toBe("dark");
  expect(bootFor("/dashboard/call/spc_123/join")).toBe("dark");
  expect(bootFor("/dashboard")).toBeNull();
  expect(bootFor("/dashboard/call/spc_123")).toBeNull();
  expect(bootFor("/docs/getting-started")).toBeNull();
});

it("paints the dashboard join boot frame in the call's theme, which follows the cookie", () => {
  document.cookie = "chalk_theme=light; path=/";
  expect(bootFor("/dashboard/call/spc_123/join")).toBe("light");
  expect(document.documentElement.getAttribute("data-chalk-theme")).toBe("light");
  expect(bootFor("/blue-river-stone")).toBe("light");
});
