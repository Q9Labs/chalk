import { expect, it } from "vitest";
import { buildStageItems, choosePrimary, type PrimaryContext } from "./stage-items";

const context: PrimaryContext = { layout: "focus", pinnedId: null, lastSpeakerId: null, seenAt: new Map() };

it("leads Spotlight with someone present, not someone reconnecting, even when the reconnecting person spoke last", () => {
  const items = buildStageItems(
    [
      { id: "me", displayName: "Alex", isLocal: true },
      { id: "eli", displayName: "Eli", isReconnecting: true, isActiveSpeaker: true },
      { id: "nora", displayName: "Nora" },
    ],
    false,
  );
  expect(choosePrimary(items, { ...context, lastSpeakerId: "eli" })?.id).toBe("nora");
});

it("still leads with a reconnecting person when they are pinned", () => {
  const items = buildStageItems(
    [
      { id: "eli", displayName: "Eli", isReconnecting: true },
      { id: "nora", displayName: "Nora" },
    ],
    false,
  );
  expect(choosePrimary(items, { ...context, pinnedId: "eli" })?.id).toBe("eli");
});

it("puts a Document on the stage without turning it into a screen share", () => {
  const items = buildStageItems([{ id: "me", displayName: "Alex", isLocal: true }], false, [{ documentId: "doc", presenterId: "me", page: 1, zoom: 100, startedAtMs: 1 }]);
  expect(items.find((item) => item.id === "document:doc")).toMatchObject({ kind: "document" });
  expect(items.some((item) => item.kind === "screen-share")).toBe(false);
});

it("leads with the newest of a screen share and a Document, before the board", () => {
  const items = buildStageItems(
    [
      { id: "me", displayName: "Alex", isLocal: true, isScreenSharing: true },
      { id: "nora", displayName: "Nora" },
    ],
    true,
    [{ documentId: "doc", presenterId: "nora", page: 1, zoom: 100, startedAtMs: 2 }],
  );
  const seenAt = new Map([
    ["screen-share:me", 1],
    ["document:doc", 2],
    ["whiteboard", 3],
  ]);
  expect(choosePrimary(items, { ...context, seenAt })?.id).toBe("document:doc");
  expect(choosePrimary(items, { ...context, seenAt: new Map([...seenAt, ["screen-share:me", 4]]) })?.id).toBe("screen-share:me");
  expect(choosePrimary(items, { ...context, pinnedId: "whiteboard", seenAt })?.id).toBe("whiteboard");
});
