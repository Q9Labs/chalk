import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { classReservation, costs, defaults, nodeOptions, planClassWindow, runCostUsd } from "./class-window-plan.mjs";
import { advancedStreams, judgeClass, judgeRun } from "./class-window-judge.mjs";

const configGo = new URL("../../features/media/sfu/internal/config/config.go", import.meta.url);

test("plan constants match the SFU config defaults", async () => {
  const source = await readFile(configGo, "utf8");
  const defaultFor = (name) => {
    const match = source.match(new RegExp(`r\\.integer\\("${name}", (\\d+),`));
    assert.ok(match, `${name} has no integer default in config.go`);
    return Number(match[1]);
  };
  assert.equal(costs.video, defaultFor("SFU_VIDEO_STREAM_COST"));
  assert.equal(costs.cameraUplink, defaultFor("SFU_CAMERA_UPLINK_COST"));
  assert.equal(costs.audio, defaultFor("SFU_AUDIO_STREAM_COST"));
  assert.equal(costs.screen, defaultFor("SFU_SCREEN_STREAM_COST"));
  assert.equal(costs.smallTile, defaultFor("SFU_SMALL_TILE_STREAM_COST"));
  assert.equal(defaults.cameras, defaultFor("SFU_CAMERAS_PER_PARTICIPANT"));
  assert.equal(defaults.episodePacketCeiling, defaultFor("SFU_EPISODE_PACKET_CEILING"));
  assert.equal(defaults.largeCallParticipants, defaultFor("SFU_LARGE_CALL_PARTICIPANTS"));
});

test("a three-person class with cameras and a share reserves 7170 packets/s", () => {
  assert.equal(classReservation({ participants: 3, cameras: 2, screen: true, budget: 36000 }), 7170);
  assert.equal(classReservation({ participants: 3, cameras: 2, screen: false, budget: 36000 }), 6390);
});

test("the Episode ceiling and the node budget cap a reservation", () => {
  assert.equal(classReservation({ budget: 5000 }), 5000);
  assert.equal(classReservation({ cameras: 8, budget: 1_000_000 }), defaults.episodePacketCeiling);
});

test("a large call is refused rather than modeled with the small-tile formula", () => {
  assert.throws(() => classReservation({ participants: 7, budget: 36000 }), /large call/);
});

test("node budgets admit three classes on one vCPU and five on two", () => {
  const byNode = Object.fromEntries(nodeOptions({ classes: 20 }).map((option) => [option.size, option]));
  assert.equal(byNode["s-1vcpu-1gb"].classesPerNode, 3);
  assert.equal(byNode["s-2vcpu-2gb"].classesPerNode, 5);
  assert.equal(byNode["s-2vcpu-2gb"].headroomPackets, 150);
});

test("twenty classes fit exactly four s-2vcpu-2gb nodes, with a headroom warning", () => {
  const plan = planClassWindow({ classes: 20 });
  assert.equal(plan.nodesNeeded, 4);
  assert.equal(plan.classesPerNode, 5);
  assert.deepEqual(plan.droplets, { "s-2vcpu-2gb": 4, "s-4vcpu-8gb": 4 });
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0], /150 packets\/s of headroom/);
});

test("a class count that leaves slots empty is reported", () => {
  const plan = planClassWindow({ classes: 19 });
  assert.equal(plan.nodesNeeded, 4);
  assert.match(plan.warnings.join("\n"), /1 class slots are unused/);
});

test("planClassWindow rejects an SFU size the node table does not measure", () => {
  assert.throws(() => planClassWindow({ classes: 5, nodeSize: "s-4vcpu-8gb" }), /not a measured SFU size/);
});

test("runCostUsd prices droplet hours from the monthly list price", () => {
  const cost = runCostUsd({ droplets: { "s-2vcpu-2gb": 4, "s-4vcpu-8gb": 4 }, hours: 3 });
  assert.ok(Math.abs(cost - (12 * 18 + 12 * 48) / 730) < 1e-9);
  assert.throws(() => runCostUsd({ droplets: { "s-9vcpu-9gb": 1 }, hours: 1 }), /no list price/);
});

// Judge fixtures: a guest is a list of inbound video rows. Cameras advance every sample unless frozen; the screen
// row advances only while the sharer is sharing, so a viewer's screen decode follows the share.
function guest({ at, shareOn, cameraFrozen = false, screenFrozen = false, cameras = 2, screen = true }) {
  const rows = [];
  for (let index = 0; index < cameras; index++) {
    rows.push({ type: "inbound-rtp", kind: "video", source: "camera", id: `cam-${index}`, connection: 0, framesDecoded: cameraFrozen ? 50 : at });
  }
  if (screen) {
    rows.push({ type: "inbound-rtp", kind: "video", source: "screen", id: "scr", connection: 0, framesDecoded: shareOn && !screenFrozen ? at : 0 });
  }
  return rows;
}

// Times are milliseconds from the window start, as class-window.mjs records them.
function samples({ durationMs = 300_000, shareFrom = 120_000, shareTo = 240_000, frozen = () => ({}), shareDisabled = false } = {}) {
  const out = [];
  for (let at = 0; at <= durationMs; at += 10_000) {
    const shareOn = !shareDisabled && at >= shareFrom && at < shareTo;
    const shareStartedAt = shareOn ? shareFrom : null;
    out.push({
      at,
      shareOn,
      shareStartedAt,
      guests: [0, 1, 2].map((index) => guest({ at, shareOn, ...frozen(index, at) })),
    });
  }
  return out;
}

test("a healthy class passes with camera and screen windows counted", () => {
  const verdict = judgeClass({ samples: samples(), participants: 3 });
  assert.equal(verdict.pass, true);
  assert.ok(verdict.camera.total > 0);
  assert.equal(verdict.camera.passed, verdict.camera.total);
  assert.ok(verdict.screen.total > 0);
  assert.equal(verdict.screen.firstFailureAt, null);
});

test("a screen that stops decoding fails at the first window after the stall", () => {
  const verdict = judgeClass({
    samples: samples({ frozen: (index, at) => (index === 1 && at >= 150_000 ? { screenFrozen: true } : {}) }),
    participants: 3,
  });
  assert.equal(verdict.pass, false);
  assert.equal(verdict.screen.firstFailureAt, 150_000);
});

test("a class that never shares fails, because a screen check with no windows cannot pass", () => {
  const verdict = judgeClass({ samples: samples({ shareDisabled: true }), participants: 3 });
  assert.equal(verdict.screen.total, 0);
  assert.equal(verdict.pass, false);
});

test("a camera stall inside the ramp is not judged", () => {
  const verdict = judgeClass({
    samples: samples({ frozen: (index, at) => (index === 0 && at >= 50_000 && at < 110_000 ? { cameraFrozen: true } : {}) }),
    participants: 3,
    rampMs: 120_000,
  });
  assert.equal(verdict.pass, true);
});

test("the sharer's own feed is not judged for screen decode", () => {
  const verdict = judgeClass({
    samples: samples({ frozen: (index) => (index === 0 ? { screenFrozen: true } : {}) }),
    participants: 3,
    sharer: 0,
  });
  assert.equal(verdict.pass, true);
});

test("advancedStreams counts only matching rows whose decoder moved", () => {
  const before = [
    { id: "a", connection: 0, source: "camera", type: "inbound-rtp", kind: "video", framesDecoded: 10 },
    { id: "b", connection: 0, source: "camera", type: "inbound-rtp", kind: "video", framesDecoded: 10 },
    { id: "c", connection: 0, source: "screen", type: "inbound-rtp", kind: "video", framesDecoded: 10 },
  ];
  const after = [
    { ...before[0], framesDecoded: 11 },
    { ...before[1], framesDecoded: 10 },
    { ...before[2], framesDecoded: 12 },
  ];
  assert.equal(advancedStreams(before, after, (row) => row.source === "camera"), 1);
});

test("judgeRun fails an empty run and names the failed classes", () => {
  assert.equal(judgeRun([]).pass, false);
  const verdict = judgeRun([
    { class: 0, pass: true },
    { class: 1, pass: false },
  ]);
  assert.deepEqual(verdict.failed, [1]);
  assert.equal(verdict.pass, false);
  assert.equal(judgeRun([{ class: 0, pass: true }]).pass, true);
});
