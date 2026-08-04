import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_SEARCH, ENTRANCE_STATES, PREVIEW_DIALOGS, PREVIEW_PANELS, PREVIEW_STAGES, SPACE_STATES, createPreviewHref, normalizePreviewSearch, parsePreviewSearch, patchPreviewSearch, serializePreviewSearch } from "./preview-state";

const LIFECYCLE_VECTORS = [...ENTRANCE_STATES.map((state) => ({ view: "entrance" as const, state })), ...SPACE_STATES.map((state) => ({ view: "space" as const, state }))] as const;

describe("native SDK preview URL state", () => {
  it("defines the supported default contract", () => {
    expect(DEFAULT_PREVIEW_SEARCH).toMatchObject({
      view: "entrance",
      state: "ready",
      panel: "none",
      stage: "people",
      dialog: "none",
      chrome: "visible",
      mic: true,
      camera: true,
      hand: false,
    });
    expect(PREVIEW_PANELS).toEqual(["none", "chat", "participants"]);
    expect(PREVIEW_STAGES).toEqual(["people", "whiteboard"]);
    expect(PREVIEW_DIALOGS).toEqual(["none", "more", "settings", "reactions"]);
    expect(DEFAULT_PREVIEW_SEARCH).not.toHaveProperty("toast");
  });

  it("accepts every view-specific lifecycle vector", () => {
    for (const vector of LIFECYCLE_VECTORS) {
      const normalized = normalizePreviewSearch(vector);

      expect(normalized.view).toBe(vector.view);
      expect(normalized.state).toBe(vector.state);
    }

    expect(parsePreviewSearch("?view=entrance&state=ended").state).toBe("ready");
    expect(parsePreviewSearch("?view=space&state=joining").state).toBe("happy");
  });

  it("normalizes unsupported controls to safe defaults", () => {
    expect(normalizePreviewSearch("?view=space&state=joining&panel=transcript&dialog=info&stage=share&participants=99&mic=0&camera=false&hand=on&toast=warning")).toMatchObject({
      view: "space",
      state: "happy",
      panel: "none",
      dialog: "none",
      stage: "people",
      participants: 5,
      mic: false,
      camera: false,
      hand: true,
      chrome: "visible",
    });
  });

  it("serializes and patches in a deterministic order", () => {
    const current = normalizePreviewSearch("?view=space&state=retry&layout=grid&participants=5&hand=true&chrome=hidden");

    expect(serializePreviewSearch(current)).toBe("view=space&state=retry&layout=grid&chrome=hidden&participants=5&hand=true");
    expect(serializePreviewSearch({ view: "space", state: "reconnecting", participants: 5, hand: true, chrome: "hidden" })).toBe("view=space&state=reconnecting&chrome=hidden&participants=5&hand=true");
    expect(serializePreviewSearch(DEFAULT_PREVIEW_SEARCH)).toBe("");
    expect(patchPreviewSearch(current, { panel: "chat", dialog: "settings", stage: "whiteboard" })).toMatchObject({ panel: "chat", dialog: "settings", stage: "whiteboard", chrome: "hidden" });
    expect(patchPreviewSearch(current, { view: "entrance" })).toMatchObject({ view: "entrance", state: "ready" });
    expect(createPreviewHref({ view: "space", state: "failure" }, "https://chalk.test/sdk-preview#space")).toBe("https://chalk.test/sdk-preview?view=space&state=failure#space");
  });
});
