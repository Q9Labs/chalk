import { launchGuests } from "./media.mjs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { bounds, callDurationMs, evidenceLine, judgeLongCall, refreshIntervalMs, refreshWindowMs, toggleSchedule, unreachableSample } from "./long-call-criteria.mjs";
import { check, mediaPlane, save } from "./runtime.mjs";

const guestCount = 3;
const sampleTimeoutMs = 5000;

/** Runs in the page: what one guest reports about its call. Self-contained, because Playwright serializes it. */
export async function browserSample() {
  const snapshot = window.proofClient.getSnapshot();
  const received = new Map();
  let outAudio = 0;
  for (const connection of window.proofConnections) {
    if (connection.connectionState === "closed") continue;
    // A connection that closes between the state read and the stats read is being replaced; the next sample sees its successor.
    const rows = await connection.getStats().catch(() => new Map());
    for (const row of rows.values()) {
      if (row.type === "outbound-rtp" && row.kind === "audio") outAudio += row.bytesSent;
      if (row.type === "inbound-rtp") received.set(row.trackIdentifier, row.bytesReceived);
    }
  }
  return {
    reachable: true,
    status: snapshot.connection.status,
    errorCode: snapshot.connection.lastError?.code ?? null,
    mic: snapshot.media.local.microphone.state === "enabled",
    camera: snapshot.media.local.camera.state === "enabled",
    pcs: window.proofConnections.map((connection) => connection.connectionState),
    outAudio,
    remotes: snapshot.media.remote.filter((entry) => entry.source === "microphone" || entry.source === "camera").map((entry) => ({ participantId: entry.participantId, source: entry.source, bytes: received.get(entry.track.id) ?? null })),
  };
}

const sampleGuest = (page) => Promise.race([page.evaluate(browserSample), new Promise((resolve) => setTimeout(() => resolve(unreachableSample), sampleTimeoutMs))]).catch(() => unreachableSample);

/** The plan `pnpm prod:proof long-call --dry-run` prints; it needs no configuration and opens no connection. */
export function longCallPlan() {
  const schedule = toggleSchedule();
  return [
    `Long call: ${guestCount} guests on ${mediaPlane}, ${callDurationMs / 1000}s (the longer of 10 minutes and two ${refreshIntervalMs / 1000 + refreshWindowMs / 1000}s access lifetimes)`,
    `Access refresh every ${refreshIntervalMs / 1000}s after a grant; the schedule below assumes the first refresh at +${refreshIntervalMs / 1000}s of the call`,
    `Samples every ${bounds.sampleIntervalMs / 1000}s; fails on a lost call, outbound audio still for ${bounds.outboundStallMs / 1000}s, inbound audio or video still for ${bounds.inboundStallMs / 1000}s, or no connected peer connection for ${bounds.disconnectedMs / 1000}s`,
    ...schedule.map(({ atMs, guest, kind, enabled }) => `+${String(atMs / 1000).padStart(4)}s guest ${guest + 1} ${kind} ${enabled ? "on" : "off"}`),
  ].join("\n");
}

async function toggle(page, { kind, enabled }) {
  await page.evaluate(({ kind: target, enabled: value }) => (target === "microphone" ? window.proofClient.media.setMicrophoneEnabled(value) : window.proofClient.media.setCameraEnabled(value)), { kind, enabled });
}

export async function longCallProof(run, receiver) {
  const space = await createSpace(run, mediaPlane);
  const { episode, end } = await createEpisode(run, space);
  run.episodeId = episode.id;
  console.log(`Joining ${guestCount} synthetic camera/voice guests on ${mediaPlane}`);
  const guests = await launchGuests(run, space, episode, "", receiver.origin, true, guestCount);
  const startedAtMs = Date.now();
  const refreshDueMs = guests.refreshes.map(({ initialExpiry }) => initialExpiry - refreshWindowMs - startedAtMs);
  const firstRefreshMs = refreshDueMs.reduce((sum, due) => sum + due, 0) / refreshDueMs.length;
  const schedule = toggleSchedule({ firstRefreshMs });
  console.log(`Holding the call for ${callDurationMs / 1000}s; first access refresh due at +${Math.round(firstRefreshMs / 1000)}s; ${schedule.length} toggles scheduled`);

  const ticks = [];
  const failures = [];
  const ran = [];
  const sampling = (async () => {
    while (Date.now() - startedAtMs < callDurationMs) {
      const t = Date.now();
      ticks.push({ t, guests: await Promise.all(guests.pages.map(sampleGuest)) });
      await run.wait(Math.max(0, bounds.sampleIntervalMs - (Date.now() - t)));
    }
  })();
  const toggling = (async () => {
    for (const entry of schedule) {
      await run.wait(Math.max(0, startedAtMs + entry.atMs - Date.now()));
      const at = Math.round((Date.now() - startedAtMs) / 1000);
      try {
        await toggle(guests.pages[entry.guest], entry);
        ran.push({ ...entry, atMs: Date.now() - startedAtMs });
      } catch (error) {
        failures.push(`Guest ${entry.guest + 1} could not turn its ${entry.kind} ${entry.enabled ? "on" : "off"} at +${at}s: ${String(error.message).split("\n")[0]}`);
      }
    }
  })();
  await Promise.all([sampling, toggling]);

  const judged = judgeLongCall({ ticks, participants: guests.participants, refreshes: guests.refreshes, toggles: ran, startedAtMs });
  failures.push(...judged.failures);
  const evidence = { ...judged.evidence, failureCount: failures.length };
  console.log(evidenceLine(evidence));
  for (const failure of failures) console.log(`Long call failure: ${failure}`);
  await save(`${run.directory}/long-call.json`, { evidence, failures, toggles: ran, ticks });
  await end();
  for (const page of guests.pages) await page.context().close();
  check(!failures.length, failures.join("; "));
  return evidence;
}
