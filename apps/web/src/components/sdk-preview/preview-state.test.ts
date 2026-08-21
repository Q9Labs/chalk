import { describe, expect, it } from "vitest";

import { DEFAULT_PREVIEW_SEARCH, ENTRANCE_STATES, PREVIEW_FEATURE_KEYS, SPACE_STATES, createPreviewHref, normalizePreviewSearch, parsePreviewSearch, patchPreviewSearch, serializePreviewSearch } from "./preview-state";

describe("preview URL state", () => {
  it("provides a coherent complete default", () => {
    expect(DEFAULT_PREVIEW_SEARCH).toMatchObject({ view: "entrance", state: "ready", panel: "none", dialog: "none", skin: "classic", palette: "light", texture: "none", stageBackground: true, mic: "enabled", camera: "enabled", hand: false });
    expect(ENTRANCE_STATES).toContain(DEFAULT_PREVIEW_SEARCH.state);
  });

  it("keeps the preview controls hidden unless a link asks for them", () => {
    expect(DEFAULT_PREVIEW_SEARCH.chrome).toBe("hidden");
    expect(parsePreviewSearch("?view=space").chrome).toBe("hidden");
    expect(createPreviewHref({ view: "space", chrome: "visible" })).toBe("/sdk-preview?view=space&chrome=visible");
  });

  it("normalizes a state from the wrong view to that view's default", () => {
    expect(parsePreviewSearch("?view=space&state=joining").state).toBe("happy");
    expect(parsePreviewSearch("?view=entrance&state=ended").state).toBe("ready");
    expect(SPACE_STATES).toContain(parsePreviewSearch("?view=space").state);
  });

  it("normalizes legacy palette and texture aliases to SDK values", () => {
    expect(parsePreviewSearch("?view=space&palette=cosmic&texture=soft-dots")).toMatchObject({ palette: "cosmic-chalk", texture: "slate" });
  });

  it("keeps skins independently addressable from palette and texture", () => {
    expect(parsePreviewSearch("?view=space&skin=chalk&palette=light&texture=none")).toMatchObject({ skin: "chalk", palette: "light", texture: "none" });
    expect(parsePreviewSearch("?skin=unexpected").skin).toBe("classic");
  });

  it("clamps invalid enums, participant counts, booleans, and numbers", () => {
    const parsed = normalizePreviewSearch({ view: "SPACE", layout: "nope", participants: "99", mic: "0", camera: "false", hand: "on" });

    expect(parsed.view).toBe("space");
    expect(parsed.layout).toBe("focus");
    expect(parsed.participants).toBe(12);
    expect(parsed.mic).toBe("disabled");
    expect(parsed.camera).toBe("disabled");
    expect(parsed.hand).toBe(true);
  });

  it("serializes keys in deterministic order and omits defaults", () => {
    const first = serializePreviewSearch({ view: "space", state: "reconnecting", skin: "chalk", palette: "light", texture: "none", participants: 5, hand: true });
    const second = serializePreviewSearch({ hand: true, participants: 5, texture: "none", palette: "light", skin: "chalk", state: "reconnecting", view: "space" });

    expect(first).toBe("view=space&state=reconnecting&skin=chalk&participants=5&hand=true");
    expect(second).toBe(first);
    expect(serializePreviewSearch(DEFAULT_PREVIEW_SEARCH)).toBe("");
  });

  it("keeps the stage background toggle in shareable preview state", () => {
    expect(parsePreviewSearch("?view=space&stageBackground=false").stageBackground).toBe(false);
    expect(createPreviewHref({ view: "space", stageBackground: false })).toBe("/sdk-preview?view=space&stageBackground=false");
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

  it("normalizes legacy media booleans and retains all five local media states", () => {
    expect(parsePreviewSearch("?mic=true&camera=0")).toMatchObject({ mic: "enabled", camera: "disabled" });
    expect(parsePreviewSearch("?mic=requesting&camera=failed")).toMatchObject({ mic: "requesting", camera: "failed" });
    expect(parsePreviewSearch("?mic=unexpected&camera=unexpected")).toMatchObject({ mic: "disabled", camera: "disabled" });
  });

  it("serializes parity controls and every feature toggle deterministically", () => {
    const parsed = normalizePreviewSearch({ view: "space", state: "left", activeSpeaker: "nora", screenShare: "remote", incomingMediaRequest: "start-camera", admissionQueue: "waiting", diagnostics: true, role: "observer", capability: "none", features: { admission: false, sounds: false } });
    const serialized = serializePreviewSearch(parsed);

    expect(serialized).toContain("state=left");
    expect(serialized).toContain("activeSpeaker=nora");
    expect(serialized).toContain("screenShare=remote");
    expect(serialized).toContain("incomingMediaRequest=start-camera");
    expect(serialized).toContain("admissionQueue=waiting");
    expect(serialized).toContain("diagnostics=true");
    expect(serialized).toContain("role=observer");
    expect(serialized).toContain("capability=none");
    expect(serialized).toContain("feature-admission=false");
    expect(serialized).toContain("feature-sounds=false");
    expect(PREVIEW_FEATURE_KEYS).toHaveLength(10);
    expect(serializePreviewSearch(parsed)).toBe(serialized);
  });

  it("merges feature patches without dropping the remaining feature map", () => {
    const current = normalizePreviewSearch({ features: { chat: false, sounds: true } });
    const patched = patchPreviewSearch(current, { features: { admission: false } });

    expect(patched.features).toMatchObject({ chat: false, admission: false, sounds: true });
    expect(Object.values(patched.features)).toHaveLength(PREVIEW_FEATURE_KEYS.length);
  });
});
