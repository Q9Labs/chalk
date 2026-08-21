import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_SEARCH, ENTRANCE_STATES, SPACE_STATES, createPreviewHref, normalizePreviewSearch, parsePreviewSearch, patchPreviewSearch, serializePreviewSearch } from "./preview-state";

describe("preview URL state", () => {
  it("provides a coherent complete default", () => {
    expect(DEFAULT_PREVIEW_SEARCH).toMatchObject({ view: "entrance", state: "ready", panel: "none", dialog: "none", skin: "classic", mic: true, camera: true, hand: false });
    expect(ENTRANCE_STATES).toContain(DEFAULT_PREVIEW_SEARCH.state);
  });

  it("normalizes a state from the wrong view to that view's default", () => {
    expect(parsePreviewSearch("?view=space&state=joining").state).toBe("happy");
    expect(parsePreviewSearch("?view=entrance&state=ended").state).toBe("ready");
    expect(SPACE_STATES).toContain(parsePreviewSearch("?view=space").state);
  });

  it("keeps the Cosmic Chalk palette addressable from direct links", () => {
    expect(parsePreviewSearch("?view=space&palette=cosmic").palette).toBe("cosmic");
  });

  it("keeps skins independently addressable from palette and texture", () => {
    expect(parsePreviewSearch("?view=space&skin=chalk&palette=paper&texture=none")).toMatchObject({ skin: "chalk", palette: "paper", texture: "none" });
    expect(parsePreviewSearch("?skin=unexpected").skin).toBe("classic");
  });

  it("clamps invalid enums, participant counts, booleans, and numbers", () => {
    const parsed = normalizePreviewSearch({ view: "SPACE", layout: "nope", participants: "99", mic: "0", camera: "false", hand: "on" });

    expect(parsed.view).toBe("space");
    expect(parsed.layout).toBe("focus");
    expect(parsed.participants).toBe(12);
    expect(parsed.mic).toBe(false);
    expect(parsed.camera).toBe(false);
    expect(parsed.hand).toBe(true);
  });

  it("serializes keys in deterministic order and omits defaults", () => {
    const first = serializePreviewSearch({ view: "space", state: "reconnecting", skin: "chalk", palette: "paper", texture: "none", participants: 5, hand: true });
    const second = serializePreviewSearch({ hand: true, participants: 5, texture: "none", palette: "paper", skin: "chalk", state: "reconnecting", view: "space" });

    expect(first).toBe("view=space&state=reconnecting&skin=chalk&palette=paper&texture=none&participants=5&hand=true");
    expect(second).toBe(first);
    expect(serializePreviewSearch(DEFAULT_PREVIEW_SEARCH)).toBe("");
  });

  it("patches typed search without dropping existing values", () => {
    const current = normalizePreviewSearch("?view=space&state=retry&layout=grid&participants=5&hand=true");
    const patched = patchPreviewSearch(current, { panel: "chat" });

    expect(patched).toMatchObject({ view: "space", state: "retry", layout: "grid", participants: 5, hand: true, panel: "chat" });
    expect(patchPreviewSearch(current, { view: "entrance" })).toMatchObject({ view: "entrance", state: "ready", layout: "grid", participants: 5, hand: true });
  });

  it("builds deterministic direct links", () => {
    expect(createPreviewHref({ view: "space", state: "happy", chat: "empty" })).toBe("/sdk-preview?view=space&chat=empty");
    expect(createPreviewHref({ view: "space", state: "failure" }, "https://chalk.test/sdk-preview#space")).toBe("https://chalk.test/sdk-preview?view=space&state=failure#space");
  });
});
