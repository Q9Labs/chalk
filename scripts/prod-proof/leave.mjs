import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { evaluateLeaves } from "./leave-criteria.mjs";
import { launchGuests, stats, checkMediaProgress } from "./media.mjs";
import { prepareIntegration } from "./proofs.mjs";
import { check, command, save } from "./runtime.mjs";

const baselineVersion = "5.2.6";

async function baselineEntry(run) {
  const metadata = await fetch(`https://registry.npmjs.org/@q9labsai%2fchalk-client/${baselineVersion}`, { signal: AbortSignal.timeout(30_000) });
  check(metadata.ok, "Baseline npm metadata is unavailable");
  const release = await metadata.json();
  const response = await fetch(release.dist.tarball, { signal: AbortSignal.timeout(30_000) });
  check(response.ok, "Baseline npm tarball is unavailable");
  const archive = Buffer.from(await response.arrayBuffer());
  check(`sha512-${createHash("sha512").update(archive).digest("base64")}` === release.dist.integrity, "Baseline tarball integrity mismatch");
  const directory = resolve(run.directory, "leave-baseline");
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, "baseline.tgz");
  await writeFile(path, archive);
  await command("tar", ["-xzf", path, "-C", directory], { signal: run.signal });
  const manifest = JSON.parse(await readFile(resolve(directory, "package/package.json"), "utf8"));
  check(manifest.version === baselineVersion, "Wrong baseline SDK version");
  await save(`${run.directory}/leave-baseline-integrity.json`, { version: baselineVersion, integrity: release.dist.integrity });
  return resolve(directory, "package", manifest.exports["."].import);
}

async function createEpisode(run) {
  const space = await run.apiRequest("POST", `${run.tenantPath}/spaces`, {
    name: run.label,
    slug: `leave-proof-${randomUUID()}`,
    metadata: { proof_run_id: run.runId },
    media_plane: "cf_sfu",
    recording_policy: "manual",
    transcription_policy: "on_demand",
    default_episode_duration_seconds: 1800,
    maximum_episode_duration_seconds: 1800,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
  });
  const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: run.runId } });
  return { space, episode };
}

async function armPublications(page, reject) {
  let acceptPoll;
  const poll = new Promise((accept) => {
    acceptPoll = accept;
  });
  let held;
  await page.route("**/media/sfu/publications*", (route) => {
    if (held || route.request().method() !== "GET") return route.continue();
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
  return page.evaluate(async (name) => {
    const startedAt = performance.timeOrigin + performance.now();
    try {
      await window.proofClient.leave();
    } catch (error) {
      // The old client's known 5-second failure is diagnostic evidence. Candidate
      // failures still fail the comparison through confirmed/deadlineFallback.
      if (!String(error).includes("left locally without a durable Leave acknowledgement")) throw error;
    }
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

async function sampleLeave(run, origin, sdkEntry, scenario) {
  const { space, episode } = await createEpisode(run);
  const resourcesStart = run.resources.length;
  const directory = resolve(run.directory, `leave-${sdkEntry ? "baseline" : "candidate"}-${scenario}-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const call = { ...run, directory };
  try {
    const guests = await launchGuests(call, space, episode, null, origin, true, 2, { sdkEntry, observeLeave: true });
    const before = await stats(guests.pages);
    await run.wait(1000);
    checkMediaProgress(before, await stats(guests.pages));
    const result = await observeDeparture(guests.pages[0], scenario);
    await save(`${directory}/leave.json`, result);
    return result;
  } finally {
    for (const resource of run.resources.slice(resourcesStart).reverse()) await resource.dispose();
    run.resources.splice(resourcesStart);
  }
}

export async function leaveProof(run) {
  const receiver = await prepareIntegration(run, false);
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
  const result = evaluateLeaves(baseline, candidate);
  await save(`${run.directory}/leave-comparison.json`, result);
  console.log(`Leave comparison: baseline median ${result.baselineMedianMs} ms, max ${result.baselineMaxMs} ms; candidate median ${result.candidateMedianMs} ms, max ${result.candidateMaxMs} ms; limit ${result.limitMs} ms; 403 observed ${result.observed403}`);
  check(result.passed, "Leave acknowledgement comparison failed");
  return result;
}
