// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { THEME_BOOTSTRAP_SCRIPT } from "./theme";

afterEach(() => {
  document.documentElement.removeAttribute("data-boot");
  window.history.replaceState(null, "", "/");
});

const bootFor = (path: string) => {
  window.history.replaceState(null, "", path);
  document.documentElement.removeAttribute("data-boot");
  // The script is our own constant, the same one the HTML shell inlines in its head.
  new Function(THEME_BOOTSTRAP_SCRIPT)();
  return document.documentElement.getAttribute("data-boot");
};

it("paints the call boot frame on invite, Space and dashboard join paths only", () => {
  expect(bootFor("/blue-river-stone")).toBe("call");
  expect(bootFor("/space/q9-team")).toBe("call");
  expect(bootFor("/dashboard/call/spc_123/join")).toBe("call");
  expect(bootFor("/dashboard")).toBeNull();
  expect(bootFor("/dashboard/call/spc_123")).toBeNull();
  expect(bootFor("/docs/getting-started")).toBeNull();
});
