import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { finding } from "./fleet-criteria.mjs";
import { parseOptions, runScheduler } from "./fleet.mjs";
import { planCall, scriptOf } from "./fleet-plan.mjs";

const options = (...args) => parseOptions(["--allow-host", "api.example.test", "--seed", "7", ...args]);
const noPulse = { pending: false, configured: false };
const record = (spec, extra = {}) => ({ id: spec.id, guests: spec.guests, recording: spec.recording, renderedAt: 0, endedAt: spec.holdSeconds * 1000, joinMs: 1000, faults: [], findings: [], actions: [], ...extra });

test("options reject a call bigger than six guests, a fault too short to prove a stall, and recording on allowlisted Spaces", () => {
  assert.throws(() => options("--guests", "2:8"), /at most 6/);
  assert.throws(() => options("--fault-seconds", "2"), /at least 4/);
  assert.throws(() => options("--recording-fraction", "0.1", "--spaces", "a,b,c,d,e,f"), /cannot combine/);
  assert.throws(() => options("--spaces", "a", "--concurrency", "3"), /at least as many Spaces/);
});

test("a call plan stays inside its ranges, always toggles the microphone, and rejoins only guests after the first", () => {
  const settings = options("--guests", "2:6", "--call-seconds", "120:240", "--rejoin-fraction", "1", "--screen-fraction", "1");
  let seed = 1;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let call = 0; call < 200; call++) {
    const plan = planCall(random, settings, `call-${call}`, false);
    assert.ok(plan.guests >= 2 && plan.guests <= 6);
    assert.ok(plan.holdSeconds >= 120 && plan.holdSeconds <= 240);
    assert.ok(plan.actions.some((action) => action.kind === "microphone"));
    for (const action of plan.actions) assert.ok(action.guest >= 0 && action.guest < plan.guests);
    assert.ok(plan.actions.filter((action) => action.kind === "rejoin").every((action) => action.guest >= 1));
  }
});

test("a call script holds between actions and mutes one guest before the last hold", () => {
  const steps = scriptOf({
    holdSeconds: 300,
    actions: [
      { kind: "microphone", guest: 0 },
      { kind: "camera", guest: 1 },
    ],
    muteHold: 1,
  });
  assert.deepEqual(
    steps.map((step) => Object.keys(step)[0]),
    ["hold", "action", "hold", "action", "mute", "hold"],
  );
  assert.equal(
    steps.filter((step) => step.hold).reduce((total, step) => total + step.hold, 0),
    300,
  );
});

test("the scheduler covers both targets, never runs more calls than the concurrency, and records one Recording at a time", async () => {
  const settings = options("--calls", "12", "--call-hours", "0.5", "--concurrency", "3", "--call-seconds", "300:300", "--recording-fraction", "1", "--max-load", "100");
  let live = 0;
  let peak = 0;
  let recordings = 0;
  let peakRecordings = 0;
  const calls = [];
  await runScheduler({
    options: settings,
    calls,
    pulse: noPulse,
    signal: new AbortController().signal,
    onFinished: () => {},
    startCall: async (spec) => {
      peak = Math.max(peak, ++live);
      if (spec.recording) peakRecordings = Math.max(peakRecordings, ++recordings);
      await new Promise((resolve) => setTimeout(resolve, 5));
      live--;
      if (spec.recording) recordings--;
      return record(spec);
    },
  });
  assert.equal(calls.length, 12);
  assert.ok(peak <= 3 && peak > 1);
  assert.equal(peakRecordings, 1);
});

test("the scheduler tops up calls until the call-hours target is covered", async () => {
  const settings = options("--calls", "2", "--call-hours", "1", "--concurrency", "2", "--call-seconds", "600:600", "--max-load", "100");
  const calls = [];
  await runScheduler({ options: settings, calls, pulse: noPulse, signal: new AbortController().signal, onFinished: () => {}, startCall: async (spec) => record(spec) });
  assert.equal(calls.length, 6, "six 10-minute calls make one call-hour");
});

test("a P1 stops new calls, lets the running ones finish, and --no-stop-on-p1 keeps going", async () => {
  const run = async (...extra) => {
    const calls = [];
    await runScheduler({
      options: options("--calls", "10", "--call-hours", "0", "--concurrency", "2", "--max-load", "100", ...extra),
      calls,
      pulse: noPulse,
      signal: new AbortController().signal,
      onFinished: () => {},
      startCall: async (spec) => record(spec, spec.id === "call-0002" ? { findings: [finding("mute_leak", "x")] } : {}),
    });
    return calls;
  };
  const stopped = await run();
  assert.ok(stopped.length < 10 && stopped.some((call) => call.findings.length === 1));
  assert.equal((await run("--no-stop-on-p1")).length, 10);
});

test("an interrupt stops new calls", async () => {
  const stop = new AbortController();
  const calls = [];
  await runScheduler({ options: options("--calls", "50", "--concurrency", "1", "--max-load", "100"), calls, pulse: noPulse, signal: stop.signal, onFinished: () => stop.abort(), startCall: async (spec) => record(spec) });
  assert.equal(calls.length, 1);
});

test("a dry run needs no API or browser and writes a summary the merge can add up", () => {
  const directory = mkdtempSync(join(tmpdir(), "fleet-"));
  const entry = join(import.meta.dirname, "fleet.mjs");
  const dry = spawnSync(process.execPath, [entry, "--dry-run", "--calls", "5", "--call-hours", "0.2", "--call-seconds", "60:120"], { cwd: directory, encoding: "utf8", env: { ...process.env, CHALK_PROOF_RUN_ID: "fleet-dry" } });
  assert.equal(dry.status, 0, dry.stderr);
  const calls = join(directory, ".private", "prod-proof", "fleet-dry", "fleet-calls.json");
  assert.equal(JSON.parse(readFileSync(calls, "utf8")).length >= 5, true);
  const merged = spawnSync(process.execPath, [entry, "--merge", calls, calls], { encoding: "utf8" });
  assert.equal(JSON.parse(merged.stdout).machines, 2);
});
