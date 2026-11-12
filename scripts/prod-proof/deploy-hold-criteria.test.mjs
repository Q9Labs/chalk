import assert from "node:assert/strict";
import test from "node:test";
import { judgeDeployHold } from "./deploy-hold-criteria.mjs";

const interval = 1000;
const guest = (t, id, extra = {}) => ({ reachable: true, status: "live", participantId: id, outAudio: t * 10, remotes: [{ bytes: t * 100 }], ...extra });
const ticksFor = (change = () => ({})) => Array.from({ length: 60 }, (_, i) => ({ t: i * interval, guests: [1, 2, 3].map((id) => guest(i, id, change(i, id))) }));
const sent = Array.from({ length: 10 }, (_, i) => ({ text: `m${i}`, sentAt: i * 1000, ok: true }));
const everyone = () => new Map(sent.map((message) => [message.text, message.sentAt + 300]));
const judge = (overrides = {}) => judgeDeployHold({ ticks: ticksFor(), sent, delivered: [everyone(), everyone()], deploy: { startedAt: 0, endedAt: 600_000 }, intervalMs: interval, ...overrides });

test("a call that never moved passes", () => assert.deepEqual(judge().failures, []));

test("a guest that leaves live for one sample fails", () => {
  const { failures } = judge({ ticks: ticksFor((i, id) => (id === 2 && i === 30 ? { status: "reconnecting" } : {})) });
  assert.match(failures[0], /guest 2 was off live for 1s/);
});

test("a new participant is a rejoin", () => {
  const ticks = ticksFor();
  ticks[40].guests[2] = { ...ticks[40].guests[2], participantId: 99 };
  assert.match(judge({ ticks }).failures[0], /guest 3 rejoined/);
});

test("received bytes that stand still for more than three seconds fail", () => {
  const { failures } = judge({ ticks: ticksFor((i) => (i >= 20 && i < 25 ? { remotes: [{ bytes: 2000 }] } : {})) });
  assert.ok(failures.some((line) => /received no media for/.test(line)));
});

test("a chat message that never arrives fails", () => {
  const partial = everyone();
  partial.delete("m4");
  assert.match(judge({ delivered: [everyone(), partial] }).failures[0], /1 chat message\(s\) never arrived, first m4 at guest 3/);
});

test("a refused chat send fails", () => {
  const refused = [{ text: "m0", sentAt: 0, ok: false }];
  assert.match(judgeDeployHold({ ticks: ticksFor(), sent: refused, delivered: [new Map(), new Map()], deploy: { startedAt: 0, endedAt: 1000 }, intervalMs: interval }).failures[0], /1 chat send/);
});
