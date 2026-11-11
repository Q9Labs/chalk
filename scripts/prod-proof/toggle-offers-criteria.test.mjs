import assert from "node:assert/strict";
import test from "node:test";
import { bounds, judgeOfferGrowth, judgeRepublishes, largest, offerSizes } from "./toggle-offers-criteria.mjs";

const steady = (rounds, size = 6000) => Array.from({ length: rounds }, () => [0, 1, 2].map(() => ({ largest: size, final: size })));

test("offer sizes count only the offers a guest sent", () => {
  const network = [
    { type: "signaling-request", operation: "tracks", sdpType: "offer", sdpBytes: 900 },
    { type: "signaling-request", operation: "renegotiate", sdpType: "answer", sdpBytes: 5000 },
    { type: "signaling-response", operation: "tracks", status: 200 },
    { type: "signaling-request", operation: "tracks/close", sdpType: "offer", sdpBytes: 1200 },
    { type: "signaling-request", operation: "access-grant", method: "POST" },
  ];
  assert.deepEqual(offerSizes(network), [900, 1200]);
  assert.deepEqual(offerSizes(network, 2), [1200]);
  assert.equal(largest([], 700), 700);
  assert.equal(largest([900, 1200], 700), 1200);
});

test("offers that stay near their first size pass, and the table shows the first, every tenth and the last round", () => {
  const { failures, table } = judgeOfferGrowth({ baseline: [6000, 6000, 6000], rounds: steady(50) });
  assert.deepEqual(failures, []);
  assert.equal(table.length, 1 + 1 + 5); // header, round 1, rounds 10 to 50
});

test("an offer that grows by a section per toggle fails and names the guest, the sizes and the allowance", () => {
  const rounds = steady(50).map((round, index) => round.map((entry, guest) => (guest === 1 ? { largest: 6000 + index * 1100, final: 6000 + index * 1100 } : entry)));
  const { failures } = judgeOfferGrowth({ baseline: [6000, 6000, 6000], rounds });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Guest 2's final offer is 5\d\d\d\d bytes after 50 rounds.*first join.*allowed 4096/);
});

test("growth within the allowance passes, and one byte over fails", () => {
  const at = (size) => judgeOfferGrowth({ baseline: [6000, 6000, 6000], rounds: steady(3, size) }).failures;
  assert.deepEqual(at(6000 + bounds.growthBytes), []);
  assert.equal(at(6000 + bounds.growthBytes + 1).length, 3);
});

test("an offer over the node's limit in any round fails, even when the last round is small", () => {
  const rounds = steady(3);
  rounds[0][2] = { largest: bounds.nodeLimitBytes + 1, final: 6000 };
  const { failures } = judgeOfferGrowth({ baseline: [6000, 6000, 6000], rounds });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Guest 3.*round 1/);
});

test("a guest with no join offer, or a call with no round, cannot pass", () => {
  assert.match(judgeOfferGrowth({ baseline: [6000, NaN, 6000], rounds: steady(2) }).failures[0], /Guest 2 sent no offer while joining/);
  assert.match(judgeOfferGrowth({ baseline: [6000], rounds: [] }).failures[0], /No toggle round ran/);
});

const heard = (speaker, round) => ({ speaker, round, verdicts: [1, 2, 3].filter((listener) => listener !== speaker + 1).map((listener) => ({ listener, speaker: speaker + 1, pass: true, peakDb: -20, bin: 4, floorDb: -95 })) });
const everyone = (rounds) => [0, 1, 2].flatMap((speaker) => Array.from({ length: rounds }, (_, round) => heard(speaker, round + 1)));

test("six heard re-publishes by every guest pass", () => {
  assert.deepEqual(judgeRepublishes({ hearings: everyone(6), guests: 3 }), []);
});

test("five re-publishes by a guest are too few", () => {
  const hearings = everyone(6).filter((hearing) => !(hearing.speaker === 2 && hearing.round === 6));
  assert.match(judgeRepublishes({ hearings, guests: 3 })[0], /Guest 3 re-published its microphone 5 times, fewer than 6/);
});

test("one deaf listener after one unmute fails and names the round, the listener and the speaker", () => {
  const hearings = everyone(6);
  hearings[7].verdicts[0].pass = false; // guest 2, round 2
  const failures = judgeRepublishes({ hearings, guests: 3 });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Round 2: guest 1 did not hear guest 2 after its unmute/);
});

test("a hearing judged by too few listeners fails", () => {
  const hearings = everyone(6);
  hearings[0].verdicts.pop();
  assert.match(judgeRepublishes({ hearings, guests: 3 })[0], /1 listeners judged guest 1, want 2/);
});
