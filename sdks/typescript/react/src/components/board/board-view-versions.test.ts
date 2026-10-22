import { expect, it } from "vitest";
import { ViewVersions } from "./board-view-versions";
import type { ChalkWhiteboardView } from "@q9labsai/chalk-client";

function receive(versions: ViewVersions, view: ChalkWhiteboardView, publisher?: string) {
  versions.observe(view, publisher);
  versions.remember(view, publisher);
}

it("accepts a restarted origin epoch while rejecting repeated sequences in the same epoch", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "peer", originEpoch: "first", originSequence: 100 };
  receive(versions, view, "publisher");
  expect(versions.isNew(view)).toBe(false);
  expect(versions.isNew({ ...view, originEpoch: "reconnected", originSequence: 1 })).toBe(true);
});

it("evicts the least recently applied origin after 256 origins", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "first", originSequence: 1 };
  receive(versions, view, "publisher");
  for (let index = 0; index < 256; index++) receive(versions, { ...view, originParticipantId: `peer-${index}` }, "publisher");
  expect(versions.isNew(view)).toBe(true);
  expect(versions.isNew({ ...view, originParticipantId: "peer-255" })).toBe(false);
});

// Exact reported order from #346 and the original #340 review, not a production trace:
// https://github.com/Q9Labs/chalk/pull/340#discussion_r4336619834
// A reset sequence now denotes a new SDK instance; automatic reconnects retain the same sequence.
it("replays the reported reconnect order A:100 → B:1 → delayed A:101 → B:2 → C:1", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "peer", originEpoch: "A", originSequence: 100, originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  receive(versions, view, "peer");
  receive(versions, { ...view, originEpoch: "B", originSequence: 1, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "peer");
  expect(versions.isNew({ ...view, originSequence: 101 })).toBe(false);
  receive(versions, { ...view, originSequence: 101 }, "peer");
  const next = { ...view, originEpoch: "B", originSequence: 2, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  expect(versions.isNew(next)).toBe(true);
  receive(versions, next, "peer");
  expect(versions.isNew({ ...view, originEpoch: "C", originSequence: 1, originConnectionId: "tab-C", originLeadStamp: "3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe(true);
});

it.each([
  ["relay", "origin"],
  ["origin", "relay"],
])("records direct epoch history with %s then %s delivery", (first, second) => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originEpoch: "A", originSequence: 100, originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  for (const publisher of [first, second]) receive(versions, view, publisher);
  expect(versions.isNew(view)).toBe(false);
  const reconnected = { ...view, originEpoch: "B", originSequence: 1, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  for (const publisher of [first, second]) receive(versions, reconnected, publisher);
  const delayed = { ...view, originSequence: 101 };
  expect(versions.isNew(delayed)).toBe(false);
  receive(versions, delayed, "origin");
  expect(versions.isNew({ ...reconnected, originSequence: 2 })).toBe(true);
});

it("does not let an unseen epoch from another publisher retire the current publisher's epoch", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originEpoch: "A", originSequence: 100, originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  receive(versions, view, "publisher-a");
  receive(versions, { ...view, originEpoch: "C", originSequence: 1, originConnectionId: "tab-C", originLeadStamp: "3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "publisher-c");
  receive(versions, { ...view, originEpoch: "B", originSequence: 1, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "publisher-b");
  expect(versions.isNew({ ...view, originEpoch: "C", originSequence: 2, originConnectionId: "tab-C", originLeadStamp: "3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe(true);
  expect(versions.isNew({ ...view, originEpoch: "C", originSequence: 1, originConnectionId: "tab-C", originLeadStamp: "3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe(false);
});

it("does not retire an origin epoch when one relay switches upstream publishers", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originEpoch: "C", originSequence: 1 };
  receive(versions, view, "relay");
  receive(versions, { ...view, originEpoch: "B" }, "relay");
  expect(versions.isNew({ ...view, originSequence: 2 })).toBe(true);
});

it.each(["origin", "relay"])("rejects the same retired origin view delivered by %s", (publisher) => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originEpoch: "A", originSequence: 100, originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  receive(versions, view, "relay");
  // A duplicate direct copy must still establish authority before the reconnect.
  versions.observe(view, "origin");
  const reconnected = { ...view, originEpoch: "B", originSequence: 1, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  versions.observe(reconnected, "origin");
  const stale = { ...view, originSequence: 101 };
  expect(versions.isNew(stale)).toBe(false);
  receive(versions, stale, publisher);
  expect(versions.isNew({ ...reconnected, originSequence: 2 })).toBe(true);
});

it("preserves retired epochs along a follow chain and cycle", () => {
  const followers = [new ViewVersions(), new ViewVersions(), new ViewVersions()];
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originEpoch: "A", originSequence: 100, originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  for (const follower of followers) {
    receive(follower, view, "origin");
    receive(follower, { ...view, originEpoch: "B", originSequence: 1, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "origin");
  }
  for (const follower of followers) {
    expect(follower.isNew({ ...view, originSequence: 101 })).toBe(false);
    expect(follower.isNew({ ...view, originEpoch: "B", originSequence: 1, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe(false);
    expect(follower.isNew({ ...view, originEpoch: "B", originSequence: 2, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" })).toBe(true);
  }
});

it("keeps legacy sequence deduplication and accepts anonymous legacy views", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "legacy", originSequence: 10 };
  receive(versions, view, "legacy");
  expect(versions.isNew(view)).toBe(false);
  expect(versions.isNew({ ...view, originSequence: 11 })).toBe(true);
  receive(versions, { ...view, originEpoch: "upgraded", originSequence: 1 }, "legacy");
  expect(versions.isNew({ ...view, originSequence: 11 })).toBe(true);
  expect(versions.isNew({ ...view, originParticipantId: undefined })).toBe(true);
});

it("bounds participant leadership history without reviving an older tab while retained", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "peer", originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "A", originSequence: 1 };
  receive(versions, view);
  receive(versions, { ...view, originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "B", originConnectionId: "tab-B" });
  for (let index = 0; index < 255; index++) receive(versions, { ...view, originParticipantId: `peer-${index}` });
  expect(versions.isNew({ ...view, originSequence: 2 })).toBe(false);
  receive(versions, { ...view, originParticipantId: "peer-255" });
  expect(versions.isNew({ ...view, originSequence: 2 })).toBe(true);
});

it("orders a participant's tabs by the server stamp, not A/C/B arrival", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "A", originSequence: 100 };
  receive(versions, view, "relay");
  receive(versions, { ...view, originEpoch: "C", originConnectionId: "tab-C", originLeadStamp: "3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originSequence: 1 }, "origin");
  receive(versions, { ...view, originEpoch: "B", originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originSequence: 1 }, "origin");
  expect(versions.isNew({ ...view, originEpoch: "C", originConnectionId: "tab-C", originLeadStamp: "3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originSequence: 2 })).toBe(true);
  expect(versions.isNew({ ...view, originSequence: 101 })).toBe(false);
});

it("retires the older tab of the same participant", () => {
  const versions = new ViewVersions();
  const view = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originConnectionId: "tab-1", originLeadStamp: "9007199254740993:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "A", originSequence: 100 };
  receive(versions, view, "origin");
  receive(versions, { ...view, originConnectionId: "tab-2", originLeadStamp: "9007199254740994:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "B", originSequence: 1 }, "origin");
  expect(versions.isNew({ ...view, originSequence: 101 })).toBe(false);
});

it("keeps legacy tabs independent when no server connection identity is available", () => {
  const versions = new ViewVersions();
  const a = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originEpoch: "tab-A", originSequence: 100 };
  receive(versions, a, "person");
  receive(versions, { ...a, originEpoch: "tab-B", originSequence: 1 }, "person");
  expect(versions.isNew({ ...a, originSequence: 101 })).toBe(true);
});

it("deduplicates a downgraded relay against its ordered origin epoch", () => {
  const versions = new ViewVersions();
  const a = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originEpoch: "A", originSequence: 101, originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  receive(versions, a, "person");
  const { originConnectionId: _connection, originLeadStamp: _incarnation, ...legacy } = a;
  expect(versions.isNew({ ...legacy, originSequence: 100 })).toBe(false);
  receive(versions, { ...a, originEpoch: "B", originSequence: 1, originConnectionId: "tab-B", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "relay");
  expect(versions.isNew({ ...legacy, originSequence: 102 })).toBe(false);
});

it.each([false, true])("retains a busy origin beyond 256 other origins, stripped metadata %s", (stripped) => {
  const versions = new ViewVersions();
  const current = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "busy", originConnectionId: "tab", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "B", originSequence: 1 };
  receive(versions, current);
  const { originConnectionId: _connection, originLeadStamp: _incarnation, ...legacy } = current;
  for (let index = 0; index < 300; index++) {
    receive(versions, { ...(stripped ? legacy : current), originSequence: index + 2 });
    receive(versions, { ...current, originParticipantId: `idle-${index}` });
    expect(versions.isNew({ ...current, originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "A", originConnectionId: "old-tab", originSequence: 999 }), `after ${index + 1} other origins`).toBe(false);
  }
  expect(versions.isNew({ ...current, originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "A", originConnectionId: "old-tab", originSequence: 999 })).toBe(false);
  expect(versions.isNew({ ...current, originSequence: 302 })).toBe(true);
});

it("records an unseen stale epoch before an old relay strips its metadata", () => {
  const versions = new ViewVersions();
  const current = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "origin", originConnectionId: "tab", originLeadStamp: "3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "C", originSequence: 1 };
  receive(versions, current);
  const stale = { ...current, originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "B" };
  versions.observe(stale);
  expect(versions.isNew(stale)).toBe(false);
  const { originConnectionId: _connection, originLeadStamp: _incarnation, ...stripped } = stale;
  expect(versions.isNew(stripped)).toBe(false);
  expect(versions.isNew({ ...current, originSequence: 2 })).toBe(true);
});

it("a real move in either tab wins, but idle arrivals and elapsed time never grant leadership", () => {
  const versions = new ViewVersions();
  const a = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originConnectionId: "a", originLeadStamp: "100:a", originEpoch: "A", originSequence: 1 };
  receive(versions, a);
  const b = { ...a, originConnectionId: "b", originLeadStamp: "200:b", originEpoch: "B" };
  receive(versions, b);
  expect(versions.isNew({ ...a, originSequence: 1000 })).toBe(false);
  const returned = { ...a, originLeadStamp: "300:a", originSequence: 1001 };
  receive(versions, returned);
  expect(versions.isNew({ ...b, originSequence: 2 })).toBe(false);
  const back = { ...b, originLeadStamp: "400:b", originSequence: 3 };
  receive(versions, back);
  expect(versions.isNew({ ...back, originSequence: 4 })).toBe(true);
});

it("a database rewind and delayed pre-restore frames cannot change last-led order", () => {
  const versions = new ViewVersions();
  const old = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originConnectionId: "survivor", originLeadStamp: "100:a", originEpoch: "A", originSequence: 100 };
  receive(versions, old);
  const restored = { ...old, originConnectionId: "new", originLeadStamp: "200:b", originEpoch: "B", originSequence: 1 };
  receive(versions, restored);
  expect(versions.isNew({ ...old, originSequence: 101 })).toBe(false);
  expect(versions.isNew({ ...restored, originSequence: 2 })).toBe(true);
  receive(versions, { ...old, originLeadStamp: "300:a", originSequence: 102 });
  expect(versions.isNew({ ...old, originLeadStamp: "300:a", originSequence: 103 })).toBe(true);
});

it("orders sequence across epochs within one tab across socket reconnects", () => {
  const versions = new ViewVersions();
  const current = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originConnectionId: "tab", originLeadStamp: "100:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", originEpoch: "A", originSequence: 100 };
  receive(versions, current);
  versions.observe({ ...current, originEpoch: "B", originSequence: 1 });
  expect(versions.isNew({ ...current, originEpoch: "B", originSequence: 1 })).toBe(false);
});

it("does not reapply a legacy copy when its authenticated metadata arrives later", () => {
  const versions = new ViewVersions();
  const legacy = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originEpoch: "A", originSequence: 100 };
  receive(versions, legacy);
  const ordered = { ...legacy, originConnectionId: "tab", originLeadStamp: "100:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  versions.observe(ordered);
  expect(versions.isNew(ordered)).toBe(false);
  expect(versions.isNew({ ...ordered, originSequence: 101 })).toBe(true);
});

it("preserves a legacy epoch's applied sequence when learning its newer tab", () => {
  const versions = new ViewVersions();
  const old = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originEpoch: "A", originSequence: 100, originConnectionId: "tab", originLeadStamp: "1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  receive(versions, old);
  const legacy = { x: 432, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originEpoch: "B", originSequence: 100 };
  receive(versions, legacy);
  const ordered = { ...legacy, originSequence: 99, originConnectionId: "tab", originLeadStamp: "2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
  versions.observe(ordered);
  expect(versions.isNew(ordered)).toBe(false);
  expect(versions.isNew({ ...ordered, originSequence: 100 })).toBe(false);
  expect(versions.isNew({ ...ordered, originSequence: 101 })).toBe(true);
});

it("forgets a participant only on authoritative leave, including legacy epochs", () => {
  const versions = new ViewVersions();
  const old = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originEpoch: "A", originSequence: 100, originConnectionId: "tab", originLeadStamp: "100:a" };
  receive(versions, old);
  const fresh = { ...old, originLeadStamp: "0:b", originSequence: 1 };
  expect(versions.isNew(fresh)).toBe(false);
  versions.forgetParticipant("person");
  expect(versions.isNew(fresh)).toBe(true);
});

it("never downgrades a legacy epoch's learned stamp after a delayed frame", () => {
  const versions = new ViewVersions();
  const old = { x: 0, y: 0, width: 100, height: 100, bring: false, originParticipantId: "person", originEpoch: "A", originSequence: 1, originConnectionId: "tab", originLeadStamp: "100:a" };
  receive(versions, old);
  receive(versions, { ...old, originSequence: 2, originLeadStamp: "200:b" });
  versions.observe(old, "delayed-relay");
  const { originConnectionId: _connection, originLeadStamp: _stamp, ...legacy } = { ...old, originSequence: 3 };
  expect(versions.isRetired(old)).toBe(true);
  expect(versions.isRetired(legacy)).toBe(false);
  expect(versions.isNew(legacy)).toBe(true);
});
