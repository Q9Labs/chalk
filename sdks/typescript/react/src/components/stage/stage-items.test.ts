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
