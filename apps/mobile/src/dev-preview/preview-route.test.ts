import { describe, expect, it } from "vitest";

import { createPreviewDeepLink, isPreviewRoute, parsePreviewRoute } from "./preview-route";

describe("native SDK preview deep links", () => {
  it("accepts the development app schemes and normalizes their search", () => {
    const chalkRoute = parsePreviewRoute("chalk://sdk-preview?view=space&state=reconnecting&participants=5", { isDevRuntime: true });
    const bundleRoute = parsePreviewRoute("ai.q9labs.chalk.mobile://sdk-preview?view=space&state=warning", { isDevRuntime: true });
    const expoRoute = parsePreviewRoute(new URL("exp+chalk-mobile://sdk-preview?view=entrance&state=ended"), { isDevRuntime: true });
    const pathRoute = parsePreviewRoute("chalk:///sdk-preview?view=space&state=retry", { isDevRuntime: true });

    expect(chalkRoute).toMatchObject({ kind: "sdk-preview", preview: { view: "space", state: "reconnecting", participants: 5 } });
    expect(bundleRoute).toMatchObject({ kind: "sdk-preview", preview: { view: "space", state: "warning" } });
    expect(expoRoute).toMatchObject({ kind: "sdk-preview", preview: { view: "entrance", state: "ready" } });
    expect(pathRoute).toMatchObject({ kind: "sdk-preview", preview: { view: "space", state: "retry" } });
    expect(isPreviewRoute("chalk://sdk-preview", { isDevRuntime: true })).toBe(true);
  });

  it("rejects preview links outside a development runtime", () => {
    expect(parsePreviewRoute("chalk://sdk-preview?view=space", { isDevRuntime: false })).toBeNull();
    expect(parsePreviewRoute("exp+chalk-mobile://sdk-preview?view=space", { isDevRuntime: false })).toBeNull();
    expect(isPreviewRoute("chalk://sdk-preview", { isDevRuntime: false })).toBe(false);
  });

  it("rejects lookalike links and malformed URLs", () => {
    const invalidUrls = ["https://sdk-preview", "chalk://sdk-preview.example.com", "chalk://other-route", "chalk://sdk-preview/extra", "chalk:///sdk-preview/extra", "chalk:///sdk-preview/other", "chalk://user@sdk-preview", "not a URL"];

    for (const url of invalidUrls) {
      expect(parsePreviewRoute(url, { isDevRuntime: true })).toBeNull();
    }
  });

  it("builds deterministic links that round-trip through the parser", () => {
    const link = createPreviewDeepLink({ view: "space", state: "failure", chat: "empty" });

    expect(link).toBe("chalk://sdk-preview?view=space&state=failure&chat=empty");
    expect(parsePreviewRoute(link, { isDevRuntime: true })).toMatchObject({ kind: "sdk-preview", preview: { view: "space", state: "failure", chat: "empty" } });
    expect(createPreviewDeepLink({ view: "space", state: "warning" }, "ai.q9labs.chalk.mobile")).toBe("ai.q9labs.chalk.mobile://sdk-preview?view=space&state=warning");
    expect(createPreviewDeepLink({ view: "entrance", state: "ready" }, "exp+chalk-mobile")).toBe("exp+chalk-mobile://sdk-preview");
  });

  it("preserves supported chrome and whiteboard state while dropping unsupported controls", () => {
    const route = parsePreviewRoute("chalk://sdk-preview?view=space&state=reconnecting&stage=whiteboard&chrome=hidden&panel=transcript&dialog=info&toast=warning", { isDevRuntime: true });

    expect(route).toMatchObject({ kind: "sdk-preview", preview: { view: "space", state: "reconnecting", stage: "whiteboard", chrome: "hidden", panel: "none", dialog: "none" } });
    expect(createPreviewDeepLink({ view: "space", state: "reconnecting", stage: "whiteboard", chrome: "hidden" })).toBe("chalk://sdk-preview?view=space&state=reconnecting&stage=whiteboard&chrome=hidden");
  });
});
