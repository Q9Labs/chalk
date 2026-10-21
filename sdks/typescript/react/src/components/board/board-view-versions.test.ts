import { expect, it } from "vitest";
import { ViewVersions } from "./board-view-versions";

it("accepts a restarted origin epoch while rejecting repeated sequences in the same epoch", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "peer", originEpoch: "first", originSequence: 100 };
  versions.remember(view);
  expect(versions.isNew(view)).toBe(false);
  expect(versions.isNew({ ...view, originEpoch: "reconnected", originSequence: 1 })).toBe(true);
});

it("evicts the least recently applied origin after 256 origins", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "first", originSequence: 1 };
  versions.remember(view);
  for (let index = 0; index < 256; index++) versions.remember({ ...view, originParticipantId: `peer-${index}` });
  expect(versions.isNew(view)).toBe(true);
  expect(versions.isNew({ ...view, originParticipantId: "peer-255" })).toBe(false);
});

it("does not reapply a delayed old-epoch frame after a transport reconnects", () => {
  const versions = new ViewVersions();
  const old = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "peer", originEpoch: "first", originSequence: 100 };
  versions.remember(old);
  versions.remember({ ...old, originEpoch: "reconnected", originSequence: 1 });
  expect(versions.isNew(old)).toBe(false);
});
