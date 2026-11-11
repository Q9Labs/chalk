import { expect, it } from "vitest";
import { handNumbers, orderParticipants } from "./participant-order";
import type { ParticipantListParticipant } from "./ParticipantsPanel";

const person = (id: string, extra: Partial<ParticipantListParticipant> = {}): ParticipantListParticipant => ({ id, displayName: id, ...extra });
const ids = (list: readonly ParticipantListParticipant[]) => list.map((entry) => entry.id);

it("puts you first, then hands in the order they went up, then hosts, then everyone else in roster order", () => {
  const groups = orderParticipants([person("zed"), person("host", { isHost: true }), person("late", { isHandRaised: true, handOrder: 2 }), person("me", { isLocal: true }), person("early", { isHandRaised: true, handOrder: 1 }), person("amy")]);
  expect(ids(groups.you)).toEqual(["me"]);
  expect(ids(groups.hands)).toEqual(["early", "late"]);
  expect(ids(groups.others)).toEqual(["host", "zed", "amy"]);
});

it("keeps a raised hand above a host and never sorts by name", () => {
  const groups = orderParticipants([person("boss", { isHost: true }), person("zoe", { isHandRaised: true, handOrder: 1 }), person("abe")]);
  expect(ids([...groups.hands, ...groups.others])).toEqual(["zoe", "boss", "abe"]);
});

it("numbers hands only from two hands up", () => {
  expect(handNumbers([person("a", { isHandRaised: true })])).toBe(false);
  expect(handNumbers([person("a", { isHandRaised: true }), person("b", { isHandRaised: true })])).toBe(true);
});
