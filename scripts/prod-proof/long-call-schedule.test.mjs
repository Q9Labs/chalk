import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { accessLifetimeMs, bounds, baselineToggles, callDurationMs, planRefreshToggles, refreshIntervalMs, refreshToggles, refreshWindowMs, toggleSchedule } from "./long-call-schedule.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

test("the call outlives two access lifetimes and refreshes at the numbers the code uses", () => {
  assert.ok(callDurationMs >= 10 * 60_000 && callDurationMs >= 2 * accessLifetimeMs);
  assert.equal(refreshIntervalMs, accessLifetimeMs - refreshWindowMs);
  assert.match(read("../../apps/api/internal/accessgrants/types.go"), new RegExp(`Lifetime\\s+=\\s+${accessLifetimeMs / 60_000} \\* time\\.Minute`));
  assert.match(read("../../sdks/typescript/client/src/access/manager.ts"), new RegExp(`DEFAULT_REFRESH_WINDOW_MS = ${refreshWindowMs}`));
});

test("every guest toggles mic and camera around each refresh boundary", () => {
  const guestCount = 10;
  const schedule = toggleSchedule({ guestCount });
  for (let boundary = refreshIntervalMs; boundary + 10_000 < callDurationMs; boundary += refreshIntervalMs) {
    const near = schedule.filter((toggle) => Math.abs(toggle.atMs - boundary) <= bounds.acrossRefreshMs);
    for (let guest = 0; guest < guestCount; guest++) {
      const own = near.filter((toggle) => toggle.guest === guest);
      assert.ok(own.some((toggle) => toggle.atMs < boundary) && own.some((toggle) => toggle.atMs >= boundary), `guest ${guest + 1} has no toggle on both sides of +${boundary / 1000}s`);
      assert.deepEqual([...new Set(own.map((toggle) => toggle.kind))].sort(), ["camera", "microphone"]);
    }
  }
  assert.ok(schedule.every((toggle, index) => index === 0 || toggle.atMs >= schedule[index - 1].atMs));
  assert.ok(schedule.every((toggle) => toggle.atMs < callDurationMs));
});

test("the refresh boundaries follow the first credential expiry of the call", () => {
  const shifted = toggleSchedule({ firstRefreshMs: 220_000 });
  assert.ok(shifted.some((toggle) => Math.abs(toggle.atMs - 220_000) <= 8000));
  assert.ok(shifted.some((toggle) => Math.abs(toggle.atMs - (220_000 + refreshIntervalMs)) <= 8000));
});

test("refreshes of different guests a few seconds apart each get their own toggles on both sides", () => {
  const dues = [
    { key: "1:a", guest: 0, dueMs: 231_000 },
    { key: "2:a", guest: 1, dueMs: 243_000 },
    { key: "3:a", guest: 2, dueMs: 234_000 },
  ];
  const planned = new Set();
  const first = planRefreshToggles({ dues, nowMs: 100_000, planned });
  assert.equal(first.length, 3 * refreshToggles(0).length);
  assert.deepEqual(planRefreshToggles({ dues, nowMs: 100_000, planned }), [], "a refresh is planned once");
  const stagger = (list) => {
    const call = healthyCall({ toggles: [...toggleSchedule({ firstRefreshMs: 5_000_000 }), ...list].sort((a, b) => a.atMs - b.atMs) });
    const refreshes = [guestWith(0, [grant(231_000), grant(471_000)]), guestWith(1, [grant(243_000), grant(483_000)]), guestWith(2, [grant(234_000), grant(474_000)])];
    return judged({
      ...call,
      refreshes,
      toggles: call.toggles
        .filter((toggle) => toggle.atMs < 460_000 || toggle.atMs > 490_000)
        .concat(refreshToggles(471_000, 0), refreshToggles(483_000, 1), refreshToggles(474_000, 2))
        .sort((a, b) => a.atMs - b.atMs),
    });
  };
  assert.deepEqual(stagger(first), []);
  // One group for all three, as the first version planned, leaves the +243 s refresh without a toggle after it.
  assert.ok(stagger(refreshToggles(231_000, 0)).some((failure) => failure.startsWith("1 access refresh(es) at +243s had no mic or camera toggle on each side")));
});

test("a refresh planned for a guest with a new grant, or too late for a group, is handled", () => {
  const planned = new Set(["1:a"]);
  assert.deepEqual(planRefreshToggles({ dues: [{ key: "1:a", dueMs: 300_000 }], nowMs: 0, planned }), []);
  assert.ok(planRefreshToggles({ dues: [{ key: "1:b", dueMs: 367_000 }], nowMs: 127_000, planned }).length > 0, "a new grant gets a new group");
  assert.deepEqual(planRefreshToggles({ dues: [{ key: "1:c", dueMs: 595_000 }], nowMs: 127_000, planned }), [], "a group would run past the end");
  assert.deepEqual(planRefreshToggles({ dues: [{ key: "1:d", dueMs: 135_000 }], nowMs: 127_000, planned }), [], "less than 9 s is left");
});

test("one group of refresh toggles has a toggle on each side of a refresh within 2 s of its due time", () => {
  const toggles = refreshToggles(300_000);
  for (let at = 298_000; at <= 302_000; at += 1000) {
    assert.ok(toggles.some((toggle) => toggle.atMs >= at - bounds.acrossRefreshMs && toggle.atMs <= at));
    assert.ok(toggles.some((toggle) => toggle.atMs >= at && toggle.atMs <= at + bounds.acrossRefreshMs));
  }
});

test("guest 1 mutes and unmutes its microphone, then guest 2 does, before the first baseline toggle", () => {
  const [first, second, third, fourth, fifth] = toggleSchedule();
  assert.deepEqual(
    [first, second, third, fourth].map(({ guest, kind, enabled }) => [guest, kind, enabled]),
    [
      [0, "microphone", false],
      [0, "microphone", true],
      [1, "microphone", false],
      [1, "microphone", true],
    ],
  );
  assert.ok(second.atMs < third.atMs && third.atMs - second.atMs <= bounds.acrossRefreshMs, "guest 2 mutes right after guest 1 is back");
  assert.ok(fourth.atMs < fifth.atMs, "the relay ends before the baseline starts");
});
