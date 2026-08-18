import { describe, expect, it } from "vitest";

import { createFakeMediaStreamTrack } from "../../test-support/fake-media-track";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { buildStageItems, choosePrimary, gridOrder, screenShareItemId, stabilizeOrder, WHITEBOARD_ITEM_ID, type PrimaryContext } from "./stage-items";

const track = (): MediaStreamTrack => createFakeMediaStreamTrack();

const person = (id: string, overrides: Partial<Participant> = {}): Participant => ({ id, displayName: id, ...overrides });

const context = (overrides: Partial<PrimaryContext> = {}): PrimaryContext => ({ layout: "focus", pinnedId: null, lastSpeakerId: null, seenAt: new Map(), ...overrides });

describe("buildStageItems", () => {
  it("lists participants, then one item per live screen share, then the whiteboard", () => {
    const share = track();
    const items = buildStageItems([person("me", { isLocal: true }), person("ada", { isScreenSharing: true, screenShareTrack: share }), person("grace", { isScreenSharing: true, screenShareTrack: null })], true);

    expect(items.map((item) => item.id)).toEqual(["me", "ada", "grace", screenShareItemId("ada"), WHITEBOARD_ITEM_ID]);
    expect(items[3]).toEqual(expect.objectContaining({ kind: "screen-share", track: share }));
  });
});

describe("stabilizeOrder", () => {
  it("keeps survivors in place and appends newcomers", () => {
    const items = buildStageItems([person("c"), person("a"), person("b")], false);
    expect(stabilizeOrder(["a", "gone", "b"], items).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});

describe("choosePrimary", () => {
  it("prefers the pinned item over everything", () => {
    const items = buildStageItems([person("me", { isLocal: true }), person("ada", { isActiveSpeaker: true, isScreenSharing: true, screenShareTrack: track() })], true);
    expect(choosePrimary(items, context({ layout: "presentation", pinnedId: "me" }))?.id).toBe("me");
  });

  it("is content-first in presentation and speaker-first in focus", () => {
    const items = buildStageItems([person("me", { isLocal: true }), person("ada", { isActiveSpeaker: true }), person("grace", { isScreenSharing: true, screenShareTrack: track() })], false);
    expect(choosePrimary(items, context({ layout: "presentation" }))?.id).toBe(screenShareItemId("grace"));
    expect(choosePrimary(items, context({ layout: "focus" }))?.id).toBe("ada");
  });

  it("promotes the newest screen share and falls back to the whiteboard", () => {
    const items = buildStageItems([person("ada", { isScreenSharing: true, screenShareTrack: track() }), person("grace", { isScreenSharing: true, screenShareTrack: track() })], true);
    const seenAt = new Map([
      [screenShareItemId("ada"), 5],
      [screenShareItemId("grace"), 2],
    ]);
    expect(choosePrimary(items, context({ layout: "presentation", seenAt }))?.id).toBe(screenShareItemId("ada"));
    expect(choosePrimary(buildStageItems([person("ada")], true), context({ layout: "presentation" }))?.id).toBe(WHITEBOARD_ITEM_ID);
  });

  it("falls back through active speaker, any speaker, last speaker, first remote, then local", () => {
    expect(choosePrimary(buildStageItems([person("me", { isLocal: true }), person("ada", { isSpeaking: true }), person("grace", { isActiveSpeaker: true })], false), context())?.id).toBe("grace");
    expect(choosePrimary(buildStageItems([person("me", { isLocal: true }), person("ada", { isSpeaking: true })], false), context())?.id).toBe("ada");
    expect(choosePrimary(buildStageItems([person("me", { isLocal: true }), person("ada"), person("grace")], false), context({ lastSpeakerId: "grace" }))?.id).toBe("grace");
    expect(choosePrimary(buildStageItems([person("me", { isLocal: true }), person("ada"), person("grace")], false), context())?.id).toBe("ada");
    expect(choosePrimary(buildStageItems([person("me", { isLocal: true })], false), context())?.id).toBe("me");
    expect(choosePrimary([], context())).toBeNull();
  });
});

describe("gridOrder", () => {
  it("moves the pinned item to the front", () => {
    const items = buildStageItems([person("a"), person("b"), person("c")], false);
    expect(gridOrder(items, "c").map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(gridOrder(items, "missing").map((item) => item.id)).toEqual(["a", "b", "c"]);
  });
});
