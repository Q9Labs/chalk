import assert from "node:assert/strict";
import test from "node:test";
import { buildCall } from "./call.mjs";
import { diagnoseRows } from "./index.mjs";
import { joinByIds } from "./join.mjs";
import { mediaOf } from "./quality.mjs";
import { normalizeRow } from "./rows.mjs";
import { EPISODE, fixture } from "./scenarios.mjs";
import { downlinkLossCall, downlinkWithoutTransportCall, nodeDroppingCall, uplinkLossCall } from "./scenarios-sfu.mjs";

const diagnose = (rows) =>
  diagnoseRows(
    EPISODE,
    rows.map((row) => normalizeRow(row)),
  );
const callOf = (rows) =>
  buildCall(
    joinByIds(
      EPISODE,
      rows.map((row) => normalizeRow(row)),
    ).joined,
  );
const kind = (result, name) => result.findings.find((finding) => finding.kind === name);
const starved = (result) => kind(result, "starved_viewer");

test("video the node's pacer dropped is the node's, and the starved viewer's cause says so", () => {
  const result = diagnose(nodeDroppingCall());
  assert.equal(kind(result, "node_dropping").side, "SFU");
  assert.equal(starved(result).side, "SFU");
  assert.match(starved(result).cause, /pacer dropped 1120 video packets/u);
  assert.equal(kind(result, "uplink_degraded"), undefined);
});

test("loss in the subscriber's own reports with nothing dropped at the node is the subscriber's downlink, and late repairs on the uplink are no loss", () => {
  const rows = downlinkLossCall();
  const result = diagnose(rows);
  assert.equal(starved(result).side, "client");
  assert.equal(starved(result).stage, "receiving");
  assert.match(starved(result).cause, /the subscriber's downlink: 9% loss, 380 ms round trip.*the node dropped nothing/u);
  assert.equal(kind(result, "uplink_degraded"), undefined);
  assert.equal(kind(result, "node_dropping"), undefined);
  const track = mediaOf(callOf(rows)).ingress[0];
  assert.ok(
    track.intervals.some((interval) => interval.rows[1].attrs["attributes.lost"] === 0 && interval.rows[0].attrs["attributes.lost"] === 4),
    "the fixture's lost counter falls after a repair",
  );
  assert.ok(
    track.intervals.every((interval) => interval.unrepairedPct === 0 || interval.missingPct < 1),
    "a fall in lost is a repair and never a loss",
  );
});

test("the publisher's lost packets and jitter at the node are the uplink, which every subscriber sees", () => {
  const result = diagnose(uplinkLossCall());
  const uplink = kind(result, "uplink_degraded");
  assert.equal(uplink.side, "client");
  assert.match(uplink.cause, /3\.8% of packets did not arrive first time.*jitter 45 ms/u);
  assert.match(starved(result).cause, /the publisher's uplink was bad at the node/u);
  assert.equal(kind(result, "downlink_degraded"), undefined);
});

test("without the transport row the node's own drops are not ruled out, so the side is unknown", () => {
  const result = diagnose(downlinkWithoutTransportCall());
  assert.equal(starved(result).side, "unknown");
  assert.match(starved(result).cause, /transport rows for it are missing/u);
  assert.equal(kind(result, "downlink_degraded").side, "unknown");
});

test("repair packets are in the packet counter, so first-arrival loss divides by what arrived first time plus what was missing", () => {
  const f = fixture();
  const rows = f.uplink("publisher", "conn-pub", 10, 20, (second) => ({ packets: (second - 10) * 1000, lost: 0, repaired: (second - 10) * 20 }));
  const [interval] = mediaOf(callOf([...f.cast(), ...rows])).ingress[0].intervals;
  assert.ok(Math.abs(interval.missingPct - 2) < 0.001, `first-arrival loss was ${interval.missingPct}`);
});

test("a packet counter that falls is a recreated track and its interval says nothing; a held track and a gap in the export are no loss", () => {
  const f = fixture();
  const lossy = (second) => ({ packets: second * 100, lost: (second - 10) * 6 });
  const reset = f.uplink("publisher", "conn-pub", 10, 100, (second) => (second === 50 ? { packets: 5, lost: 600 } : lossy(second)));
  const track = mediaOf(callOf([...f.cast(), ...reset])).ingress[0];
  const around = track.intervals.filter((interval) => interval.rows.some((row) => row.time === track.rows.find((r) => r.attrs["attributes.packets"] === 5).time));
  assert.ok(around.length === 2 && around.some((interval) => interval.reset), "the fall in packets is a reset");
  assert.ok(around.filter((interval) => interval.reset).every((interval) => interval.missingPct === undefined));

  const held = f.uplink("publisher", "conn-pub", 10, 100, (second) => ({ ...lossy(second), held: true }));
  assert.equal(kind(diagnose([...f.cast(), ...held]), "uplink_degraded"), undefined);

  const sparse = [...f.uplink("publisher", "conn-pub", 10, 40, lossy), ...f.uplink("publisher", "conn-pub", 200, 230, lossy)];
  const gaps = mediaOf(callOf([...f.cast(), ...sparse])).ingress[0].intervals;
  assert.ok(!gaps.some((interval) => interval.to - interval.from > 35_000), "rows further apart than the export cadence are no interval");
});

test("an egress total that falls when a subscriber closes a track is not read, only the gauges are", () => {
  const f = fixture();
  const down = f.downlink("viewer", "conn-view", 10, 60, (second) => ({ pli_received: second === 40 ? 1 : second, nack_received: second === 40 ? 0 : second * 2, lost: second === 40 ? 0 : second * 3, loss_share: 0 }));
  const result = diagnose([...f.cast(), ...f.flow(), ...f.healthyViewing(), ...f.nodeStart(), ...down]);
  assert.equal(kind(result, "downlink_degraded"), undefined);
  assert.equal(result.findings.length, 0);
});
