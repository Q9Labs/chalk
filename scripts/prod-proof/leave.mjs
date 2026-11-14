import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { baselineEntry } from "./leave-baseline.mjs";
import { evaluateLeaves, evaluateOwnLeaves } from "./leave-criteria.mjs";
import { launchGuests, waitForMediaProgress } from "./media.mjs";
import { createSpace, episodeEnd, prepareIntegration, trackEpisode } from "./proofs.mjs";
import { check, mediaPlane, save } from "./runtime.mjs";

async function createEpisode(run) {
  const space = await createSpace(run);
  const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: run.runId } });
  // A reused (pinned) Space takes one live Episode at a time, so each sample ends its own.
  if (mediaPlane === "cf_sfu") return { space, episode };
  await trackEpisode(run, space, episode);
  return { space, episode, ending: episodeEnd(run, `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`) };
}

// The SDK lists publications with GET publications, or with POST signal {op: "publications"} when the API advertises the unified route.
function isPublicationsPoll(request) {
  const { pathname } = new URL(request.url());
  if (pathname.endsWith("/media/sfu/publications")) return request.method() === "GET";
  return pathname.endsWith("/media/sfu/signal") && request.method() === "POST" && request.postDataJSON()?.op === "publications";
}

async function armPublications(page, reject) {
  let acceptPoll;
  const poll = new Promise((accept) => {
    acceptPoll = accept;
  });
  let held;
  await page.route(/\/media\/sfu\/(publications|signal)(\?.*)?$/, (route) => {
    if (held || !isPublicationsPoll(route.request())) return route.continue();
    held = route;
    acceptPoll();
  });
  await page.exposeFunction("proofReleasePublications", async () => {
    if (!reject) return;
    await held.fulfill({ status: 403, contentType: "application/json", headers: { "access-control-allow-origin": new URL(page.url()).origin }, body: JSON.stringify({ error: { code: "access.forbidden", message: "Proof rejection during Leave" } }) });
  });
  await Promise.race([
    poll,
    page.waitForTimeout(30_000).then(() => {
      throw new Error("SDK background publications poll was not observed");
    }),
  ]);
}

async function observeDeparture(page, scenario) {
  // Both sides begin with an actual background request held. Ordinary Leaves
  // keep it held; the fault scenario delivers 403 as the Leave is sent. Never
  // delay the outbound Leave or its server acknowledgement.
  await armPublications(page, scenario === "publications-403");
  return measureLeave(page, scenario);
}

// Leave from the page and report what the observation installed by observeLeave saw.
export function measureLeave(page, scenario) {
  return page.evaluate(async (name) => {
    async function attemptLeave() {
      try {
        await window.proofClient.leave();
      } catch (error) {
        // Keep the old client's known deadline as failed-ack evidence. Candidate
        // failures still fail through confirmed/deadlineFallback.
        if (!String(error).includes("left locally without a durable Leave acknowledgement")) throw error;
      }
    }
    const startedAt = performance.timeOrigin + performance.now();
    await attemptLeave();
    const probe = window.proofLeave;
    const completedAt = performance.timeOrigin + performance.now();
    return {
      scenario: name,
      socketEvidence: { sentAt: probe.sentAt, ackAt: probe.ackAt, frames: probe.frames, peerCloses: probe.peerCloses, rejections: probe.rejections },
      confirmed: probe.ackAt !== null,
      ms: (probe.ackAt ?? completedAt) - startedAt,
      deadlineFallback: probe.ackAt === null || completedAt - startedAt >= 39_000,
      rejectedWhileLeaving: probe.rejections.some((row) => row.lifecycle === "leaving" && row.at >= startedAt),
      peerClosedBeforeAck: probe.peerCloses.some((at) => at >= startedAt && (probe.ackAt === null || at < probe.ackAt)),
    };
  }, scenario);
}

export async function sampleLeave(run, origin, sdkEntry, scenario) {
  const { space, episode, ending } = await createEpisode(run);
  const resourcesStart = run.resources.length;
  const directory = resolve(run.directory, `leave-${sdkEntry ? "baseline" : "candidate"}-${scenario}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const call = { ...run, directory };
  try {
    const guests = await launchGuests(call, space, episode, null, origin, true, 2, { sdkEntry, observeLeave: true });
    await save(`${directory}/initial-media-progress.json`, await waitForMediaProgress(guests.pages));
    const result = await observeDeparture(guests.pages[0], scenario);
    await save(`${directory}/leave.json`, result);
    return result;
  } finally {
    for (const resource of run.resources.slice(resourcesStart).reverse()) await resource.dispose();
    run.resources.splice(resourcesStart);
    await ending?.end();
  }
}

function capturedBaseline() {
  const value = process.env.CHALK_PROOF_LEAVE_BASELINE_MEDIAN_MS;
  return { median: value ? Number(value) : undefined, evidence: process.env.CHALK_PROOF_LEAVE_BASELINE_EVIDENCE_SHA256 || null };
}

// chalk_sfu: the earlier SDK cannot join a Chalk SFU Episode, so the Leaves are judged on absolute bounds alone.
async function ownLeaveProof(run, receiver) {
  const samples = [];
  for (let index = 0; index < 5; index++) {
    samples.push(await sampleLeave(run, receiver.origin, undefined, "ordinary"));
    samples.push(await sampleLeave(run, receiver.origin, undefined, "publications-403"));
    await save(`${run.directory}/leave-samples.json`, { samples });
  }
  const result = evaluateOwnLeaves(samples);
  await save(`${run.directory}/leave-comparison.json`, result);
  console.log(`Leave on ${mediaPlane}: median ${result.medianMs} ms, max ${result.maxMs} ms; limit ${result.limitMs} ms; 403 observed ${result.observed403}`);
  check(result.passed, "Leave acknowledgement check failed");
  return result;
}

export async function leaveProof(run) {
  const receiver = await prepareIntegration(run, false);
  if (mediaPlane === "chalk_sfu") return ownLeaveProof(run, receiver);
  const entry = await baselineEntry(run);
  const baseline = [];
  const candidate = [];
  const baselineFault = await sampleLeave(run, receiver.origin, entry, "publications-403");
  await save(`${run.directory}/leave-baseline-403.json`, baselineFault);
  check(baselineFault.rejectedWhileLeaving && baselineFault.peerClosedBeforeAck, "Baseline 403 did not reproduce the premature peer close");
  for (let index = 0; index < 5; index++) {
    baseline.push(await sampleLeave(run, receiver.origin, entry, "ordinary"));
    candidate.push(await sampleLeave(run, receiver.origin, undefined, "ordinary"));
    candidate.push(await sampleLeave(run, receiver.origin, undefined, "publications-403"));
    await save(`${run.directory}/leave-samples.json`, { baseline, candidate });
  }
  const captured = capturedBaseline();
  const result = evaluateLeaves(baseline, candidate, captured.median);
  result.baselineEvidenceSha256 = captured.evidence;
  await save(`${run.directory}/leave-comparison.json`, result);
  console.log(`Leave comparison: baseline median ${result.baselineMedianMs} ms, max ${result.baselineMaxMs} ms; candidate median ${result.candidateMedianMs} ms, max ${result.candidateMaxMs} ms; limit ${result.limitMs} ms; 403 observed ${result.observed403}`);
  check(result.passed, "Leave acknowledgement comparison failed");
  return result;
}
