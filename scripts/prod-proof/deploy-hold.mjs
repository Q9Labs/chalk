import { access } from "node:fs/promises";
import { launchGuests } from "./media.mjs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { sampleGuest } from "./long-call.mjs";
import { judgeCall, longestGaps } from "./deploy-hold-criteria.mjs";
import { check, save } from "./runtime.mjs";

const sampleIntervalMs = 500;
const settleMs = 20_000;
const tailMs = 90_000;
const guestsPerCall = 3;
const calls = (process.env.DEPLOY_HOLD_PLANES ?? "chalk_sfu,cf_sfu,cf_sfu").split(",");
const startedFile = process.env.DEPLOY_HOLD_STARTED_FILE;
const doneFile = process.env.DEPLOY_HOLD_DONE_FILE;
const maxHoldMs = Number(process.env.DEPLOY_HOLD_MAX_MS ?? 25 * 60_000);

const exists = (path) => access(path).then(() => true, () => false);

/**
 * Holds several calls open while an operator deploys the API host, then judges each call: how many were live, how many survived and the longest media gap.
 * The deploy is outside this proof. It reads DEPLOY_HOLD_STARTED_FILE and DEPLOY_HOLD_DONE_FILE, which the operator creates when the deploy starts and when it ends.
 */
export async function deployHoldProof(run, receiver) {
  check(startedFile && doneFile, "DEPLOY_HOLD_STARTED_FILE and DEPLOY_HOLD_DONE_FILE are required");
  const joined = [];
  for (const [index, plane] of calls.entries()) {
    const space = await createSpace(run, plane);
    const { episode, end } = await createEpisode(run, space);
    const guests = await launchGuests(run, space, episode, "", receiver.origin, true, guestsPerCall, { plane });
    joined.push({ index, plane, space, episode, guests, end, ticks: [] });
    console.log(`Call ${index + 1}: ${guestsPerCall} guests on ${plane}`);
  }
  const startedAtMs = Date.now();
  let deployStartedAtMs = null;
  let deployDoneAtMs = null;
  let announced = false;
  while (true) {
    const t = Date.now();
    const sampled = await Promise.all(joined.map((call) => Promise.all(call.guests.pages.map(sampleGuest))));
    joined.forEach((call, i) => call.ticks.push({ t, guests: sampled[i] }));
    if (!announced && t - startedAtMs >= settleMs) {
      announced = true;
      console.log(`DEPLOY_HOLD_READY ${t}`);
    }
    if (deployStartedAtMs === null && (await exists(startedFile))) {
      deployStartedAtMs = t;
      console.log(`DEPLOY_HOLD_STARTED ${t}`);
    }
    if (deployDoneAtMs === null && (await exists(doneFile))) {
      deployDoneAtMs = t;
      console.log(`DEPLOY_HOLD_DONE ${t}`);
    }
    if (deployDoneAtMs !== null && t - deployDoneAtMs >= tailMs) break;
    check(t - startedAtMs < maxHoldMs, `The deploy did not finish within ${maxHoldMs / 1000}s of the call start`);
    await run.wait(Math.max(0, sampleIntervalMs - (Date.now() - t)));
  }
  const results = [];
  for (const call of joined) {
    const live = await run.apiRequest("GET", `${run.tenantPath}/spaces/${call.space.id}/episodes/${call.episode.id}`).then((episode) => episode.status, (error) => `unreadable: ${error.message}`);
    const failures = judgeCall(call.ticks, guestsPerCall);
    if (live !== "active") failures.push(`Episode status is ${live}`);
    const gaps = Array.from({ length: guestsPerCall }, (_, guest) => longestGaps(call.ticks, guest));
    const worst = gaps.reduce((a, b) => (b.ms > a.ms ? b : a));
    const offLive = call.ticks.flatMap((tick) => tick.guests.map((sample, guest) => ({ t: tick.t, guest, live: sample.reachable && sample.status === "live" }))).filter((entry) => !entry.live);
    results.push({
      call: call.index + 1,
      plane: call.plane,
      survived: failures.length === 0,
      failures,
      longestAudioGapMs: worst.ms,
      longestAudioGapEndedAtMs: worst.endedAtMs,
      samplesNotLive: offLive.length,
      gapsByGuestMs: gaps.map((gap) => gap.ms),
    });
  }
  const evidence = {
    deployStartedAtMs,
    deployDoneAtMs,
    holdMs: Date.now() - startedAtMs,
    callsLive: results.length,
    callsSurvived: results.filter((result) => result.survived).length,
    longestAudioGapMs: Math.max(...results.map((result) => result.longestAudioGapMs)),
    results,
  };
  await save(`${run.directory}/deploy-hold.json`, { evidence, ticks: joined.map((call) => ({ plane: call.plane, ticks: call.ticks })) });
  console.log(`DEPLOY_HOLD_RESULT ${JSON.stringify(evidence)}`);
  for (const call of joined) await call.end();
  for (const call of joined) for (const page of call.guests.pages) await page.context().close();
  check(evidence.callsSurvived === evidence.callsLive, `${evidence.callsLive - evidence.callsSurvived} of ${evidence.callsLive} calls did not survive the deploy`);
  return evidence;
}
