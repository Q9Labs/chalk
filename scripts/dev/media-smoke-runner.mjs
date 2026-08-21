import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PHASES, UNSUPPORTED_ASSERTIONS, createFailureRecorder, failureFrom, readReadyRuntimeManifest, redactProof, runPhase, unsupported } from "./media-smoke-core.mjs";
import { createParticipantContext, joinParticipant, launchBrowser, leaveParticipant, proveStatsWindow, queryObservability, readTrackerJourneyIDs, stopParticipantCamera, waitForRemoteTracks } from "./media-smoke-browser.mjs";

async function writeProof(report, runtime, options) {
  const target = options.proofPath ?? runtime?.proofPath;
  const redacted = redactProof(report);
  if (target && options.writeProof !== false) {
    await (options.mkdir ?? mkdir)(dirname(target), { recursive: true });
    await (options.writeFile ?? writeFile)(target, `${JSON.stringify(redacted, null, 2)}\n`, { mode: 0o600 });
  }
  return redacted;
}

async function cleanupParticipants(participants, browser, runtime, options, report) {
  const failures = [];
  for (const participant of [...participants].reverse()) {
    if (participant.joined) {
      try {
        await leaveParticipant(participant);
      } catch (error) {
        failures.push(failureFrom(error, PHASES.cleanup));
      }
    }
    try {
      await participant.context?.close();
    } catch (error) {
      failures.push(failureFrom(error, PHASES.cleanup));
    }
  }
  if (typeof options.cleanupEpisode === "function") {
    try {
      await options.cleanupEpisode({ runtime, participants });
    } catch (error) {
      failures.push(failureFrom(error, PHASES.cleanup));
    }
  }
  try {
    await browser?.close();
  } catch (error) {
    failures.push(failureFrom(error, PHASES.cleanup));
  }
  report.cleanup = { status: failures.length === 0 ? "passed" : "failed", failures };
  if (failures.length > 0) report.result = "failed";
  return failures;
}

export async function runMediaProof(input, options = {}) {
  const failureRecorder = createFailureRecorder();
  const report = { schemaVersion: 1, result: "failed", startedAt: new Date().toISOString(), provider: "cloudflare_sfu", phases: [], failureRecorder, cleanup: { status: "pending", failures: [] } };
  let runtime;
  let browser;
  const participants = [];
  try {
    runtime = await runPhase(report, PHASES.manifest, () => readReadyRuntimeManifest(input, options));
    report.runtime = { id: runtime.runtimeID, status: runtime.status, webOrigin: runtime.webOrigin };
    browser = await runPhase(report, PHASES.browser, () => launchBrowser(options));

    const primary = await runPhase(report, PHASES.primaryJoin, async () => {
      const participant = { name: runtime.participantNames.primary, ...(await createParticipantContext(browser, options)) };
      participants.push(participant);
      await joinParticipant(participant, runtime);
      participant.joined = true;
      const inviteURL = new URL(participant.page.url());
      if (!hasSpaceInviteToken(inviteURL.hash)) unsupported(UNSUPPORTED_ASSERTIONS.inviteCapability);
      participant.inviteURL = inviteURL.toString();
      return participant;
    });

    const guest = await runPhase(report, PHASES.guestJoin, async () => {
      const participant = { name: runtime.participantNames.guest, inviteURL: primary.inviteURL, ...(await createParticipantContext(browser, options)) };
      participants.push(participant);
      await joinParticipant(participant, runtime);
      participant.joined = true;
      return participant;
    });
    await runPhase(report, PHASES.media, () => waitForRemoteTracks([primary, guest], runtime));
    report.stats = await runPhase(report, PHASES.stats, () => proveStatsWindow([primary, guest], runtime));
    report.stopCamera = await runPhase(report, PHASES.stopCamera, () => stopParticipantCamera(primary, guest, runtime));
    report.journeyIDs = await readTrackerJourneyIDs(participants);
    report.observability = await runPhase(report, PHASES.observability, () => queryObservability(runtime, report.journeyIDs, options));
    report.result = "passed";
  } catch (error) {
    const phase = error?.phase ?? report.phases.findLast((candidate) => candidate.status === "failed")?.phase ?? report.phases.findLast((candidate) => candidate.status === "pending")?.phase ?? PHASES.manifest;
    failureRecorder.record(failureFrom(error, phase));
  } finally {
    const cleanupPhase = { phase: PHASES.cleanup, status: "running", startedAt: new Date().toISOString() };
    report.phases.push(cleanupPhase);
    try {
      await cleanupParticipants(participants, browser, runtime, options, report);
      cleanupPhase.status = report.cleanup.status === "passed" ? "passed" : "failed";
    } catch (error) {
      cleanupPhase.status = "failed";
      report.result = "failed";
      report.cleanup = { status: "failed", failures: [failureFrom(error, PHASES.cleanup)] };
    }
    cleanupPhase.finishedAt = new Date().toISOString();
    if (report.cleanup.failures.length > 0 && !failureRecorder.firstFailure) failureRecorder.record(report.cleanup.failures[0]);
    report.firstFailure = failureRecorder.firstFailure;
    report.finishedAt = new Date().toISOString();
    delete report.failureRecorder;
    try {
      const redacted = await writeProof(report, runtime, options);
      Object.assign(report, redacted);
    } catch (error) {
      report.result = "failed";
      if (!failureRecorder.firstFailure) failureRecorder.record(failureFrom(error, PHASES.cleanup));
      report.firstFailure = failureRecorder.firstFailure;
      report.cleanup = { status: "failed", failures: [...report.cleanup.failures, failureFrom(error, PHASES.cleanup)] };
    }
  }
  return redactProof(report);
}

function hasSpaceInviteToken(hash) {
  if (!hash || !hash.startsWith("#")) return false;
  const token = new URLSearchParams(hash.slice(1)).get("spaceInviteToken");
  return typeof token === "string" && token.startsWith("cspi1");
}
