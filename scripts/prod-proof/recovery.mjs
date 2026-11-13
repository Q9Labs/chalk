#!/usr/bin/env node
// How long a live call takes to come back after one fault, measured from two real SDK clients in Chromium.
//
//   pnpm prod:recovery --environment staging --scenario sfu-restart --start-cmd 'ssh node systemctl --user restart chalk-sfu'
//   pnpm prod:recovery --environment staging --scenario blackout-5s --start-cmd '...drop traffic' --hold-s 5 --end-cmd '...restore traffic'
//
// One run is one Episode on the own SFU with two guests who join and then publish steadily. The harness then runs --start-cmd (the
// fault is in force when it returns), waits --hold-s seconds, runs --end-cmd, and watches both pages for --watch-s more seconds.
// Each page samples its own call every 100 ms: whether audio packets and decoded video frames still arrive, and the SDK's connection
// status. The harness never touches the call after the fault, so any recovery is the product's own.
//
// Result in .private/prod-proof/<run>/recovery.json, per direction: "down" is what guest 2 receives from guest 1 and "up" what guest 1
// receives from guest 2. Run client-side faults against guest 2 only by giving --guest2-chromium a launcher that starts Chromium in
// its own network namespace (recovery-rig). Take the staging lease (scripts/staging-sfu/staging-lock) around every run.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { exec } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { check, save } from "./runtime.mjs";
import { runStandalone } from "./standalone.mjs";
import { launchGuests } from "./media.mjs";
import { createSpace, episodeEnd, postEpisode, trackEpisode } from "./proofs.mjs";
import { installLatencyProbe } from "./latency-probe.mjs";
import { recoveryOf } from "./recovery-analysis.mjs";
import { installRecoverySampler } from "./recovery-sampler.mjs";

const run$ = promisify(exec);
const clock = () => performance.timeOrigin + performance.now();
const readyTimeoutMs = 30_000;

function options() {
  const { values } = parseArgs({
    options: {
      environment: { type: "string" },
      scenario: { type: "string" },
      "start-cmd": { type: "string" },
      "end-cmd": { type: "string" },
      "hold-s": { type: "string", default: "0" },
      "settle-s": { type: "string", default: "10" },
      "watch-s": { type: "string", default: "90" },
      "guest2-chromium": { type: "string" },
    },
  });
  check(values.environment, "--environment must name where the API runs", "configuration");
  check(values.scenario && /^[a-z0-9-]+$/.test(values.scenario), "--scenario needs a label of lowercase letters, digits and dashes", "configuration");
  check(values["start-cmd"], "--start-cmd is the command that puts the fault in force", "configuration");
  const number = (name, max) => {
    const value = Number(values[name]);
    check(Number.isFinite(value) && value >= 0 && value <= max, `--${name} must be a number from 0 to ${max}`, "configuration");
    return value;
  };
  return {
    environment: values.environment,
    scenario: values.scenario,
    startCmd: values["start-cmd"],
    endCmd: values["end-cmd"],
    holdS: number("hold-s", 600),
    settleS: number("settle-s", 120),
    watchS: number("watch-s", 600),
    guest2Chromium: values["guest2-chromium"],
  };
}

async function shell(command) {
  const startedAt = clock();
  const { stdout } = await run$(command, { timeout: 120_000 });
  return { ms: Math.round(clock() - startedAt), output: stdout.trim().slice(0, 400) };
}

async function waitReady(page) {
  const id = randomUUID();
  await page.evaluate((watch) => window.proofLatency.arm(watch.id, [{ name: "ready", kind: "ready" }], watch.timeoutMs), { id, timeoutMs: readyTimeoutMs });
  return id;
}

async function callUnderFault(run, origin, settings) {
  const space = await createSpace(run, "chalk_sfu");
  const { episode, path } = await postEpisode(run, space);
  await trackEpisode(run, space, episode);
  const ending = episodeEnd(run, path);
  const executablePaths = settings.guest2Chromium ? { 1: settings.guest2Chromium } : undefined;
  try {
    const guests = await launchGuests(run, space, episode, null, origin, true, 2, { deferJoin: true, plane: "chalk_sfu", observeLeave: true, executablePaths });
    const { pages } = guests;
    for (const page of pages) await page.evaluate(installLatencyProbe);
    const join = (guest) => ({ slug: space.slug, api: run.config.api_url, name: `Proof guest ${guest + 1}` });
    for (const [guest, page] of pages.entries()) {
      const id = await waitReady(page);
      await page.evaluate((step) => window.proofLatency.act("join", step), join(guest));
      const [seen] = await page.evaluate((watch) => window.proofLatency.result(watch), id);
      check(seen.at !== null, `guest ${guest + 1} was not live ${readyTimeoutMs / 1000} s after join`, "recovery");
    }
    for (const page of pages) await page.evaluate(installRecoverySampler);
    await sleep(settings.settleS * 1000);

    const faultStart = clock();
    const started = await shell(settings.startCmd);
    await sleep(settings.holdS * 1000);
    const ended = settings.endCmd ? await shell(settings.endCmd) : null;
    const faultEnd = clock();
    await sleep(settings.watchS * 1000);
    const watchEnd = clock();

    const window_ = { faultStart, faultEnd, watchEnd };
    const [up, down] = await Promise.all(pages.map((page) => page.evaluate(() => window.proofSampler.take())));
    // pages[0] receives guest 2's media (up); pages[1] receives guest 1's media (down).
    return {
      fault: { start_cmd_ms: started.ms, hold_s: settings.holdS, end_cmd_ms: ended?.ms ?? null, held_s: Math.round((faultEnd - faultStart) / 100) / 10 },
      down: recoveryOf(down, window_),
      up: recoveryOf(up, window_),
    };
  } finally {
    await ending.end().catch((error) => console.warn(`end Episode: ${error instanceof Error ? error.message : String(error)}`));
  }
}

async function main() {
  const settings = options();
  const report = { startedAt: new Date().toISOString(), scenario: settings.scenario, environment: settings.environment };
  const { directory } = await runStandalone("recovery", report, async (run, receiver) => {
    Object.assign(report, await callUnderFault(run, receiver.origin, settings));
  }, { readiness: false });
  await save(`${directory}/recovery.json`, report);
  console.log(JSON.stringify({ scenario: report.scenario, fault: report.fault, down: report.down, up: report.up }, null, 1));
  console.log(`Private evidence: ${directory}`);
  if (report.error || report.cleanupError) process.exitCode = 1;
}

await main();
