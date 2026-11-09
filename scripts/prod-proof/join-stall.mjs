import { launchGuests } from "./media.mjs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { mediaPlane, save } from "./runtime.mjs";

/** Runs in each guest's page: every 250 ms, the per-track receive and send counters of every live peer connection. Self-contained, because Playwright serializes it. */
export function installStallProbe() {
  const now = () => performance.timeOrigin + performance.now();
  window.__stall = [];
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  (async () => {
    for (;;) {
      const t = now();
      const inbound = [];
      const outbound = [];
      let pair = null;
      for (const [pc, connection] of (window.proofConnections ?? []).entries()) {
        if (connection.connectionState === "closed") continue;
        const rows = await connection.getStats().catch(() => new Map());
        for (const r of rows.values()) {
          if (r.type === "inbound-rtp")
            inbound.push({
              pc,
              id: r.trackIdentifier,
              kind: r.kind,
              bytes: r.bytesReceived,
              packets: r.packetsReceived,
              lost: r.packetsLost,
              received: r.framesReceived,
              decoded: r.framesDecoded,
              keyframes: r.keyFramesDecoded,
              pli: r.pliCount,
              nack: r.nackCount,
              freezes: r.freezeCount,
              freezeSeconds: r.totalFreezesDuration,
              width: r.frameWidth,
              dropped: r.framesDropped,
            });
          else if (r.type === "outbound-rtp") outbound.push({ pc, kind: r.kind, rid: r.rid ?? null, bytes: r.bytesSent, encoded: r.framesEncoded, keyframes: r.keyFramesEncoded, pli: r.pliCount, nack: r.nackCount, limit: r.qualityLimitationReason, width: r.frameWidth });
          else if (r.type === "candidate-pair" && r.nominated && r.state === "succeeded") pair = { rtt: r.currentRoundTripTime, available: r.availableOutgoingBitrate };
        }
      }
      const snapshot = window.proofClient?.getSnapshot();
      window.__stall.push({
        t,
        status: snapshot?.connection.status ?? null,
        roster: snapshot?.participants.roster.length ?? null,
        remotes: snapshot?.media.remote.map((entry) => ({ participantId: entry.participantId, source: entry.source, id: entry.track.id, state: entry.track.readyState, muted: entry.track.muted })) ?? [],
        pcs: (window.proofConnections ?? []).map((connection) => connection.connectionState),
        inbound,
        outbound,
        pair,
      });
      await pause(Math.max(0, 250 - (now() - t)));
    }
  })();
}

/** Two guests join, a third joins `JOIN_STALL_LATE_MS` later (0 for all at once), and every guest records its media for `JOIN_STALL_HOLD_MS` after the last join. */
export async function joinStallProof(run, receiver) {
  const lateMs = Number(process.env.JOIN_STALL_LATE_MS ?? 25000);
  const holdMs = Number(process.env.JOIN_STALL_HOLD_MS ?? 60000);
  const space = await createSpace(run, mediaPlane);
  const { episode, end } = await createEpisode(run, space);
  run.episodeId = episode.id;
  const guests = await launchGuests(run, space, episode, "", receiver.origin, true, 3, { diagnostics: true, deferJoin: true });
  for (const page of guests.pages) await page.evaluate(installStallProbe);
  const joins = [];
  const join = async (index) => {
    const entry = { guest: index + 1, startedAt: Date.now(), resolvedAt: null };
    joins.push(entry);
    await guests.pages[index].evaluate(({ slug, api, name }) => window.proofJoin(slug, api, name), { slug: space.slug, api: run.config.api_url, name: `Proof guest ${index + 1}` });
    entry.resolvedAt = Date.now();
  };
  if (lateMs === 0) await Promise.all([join(0), join(1), join(2)]);
  else {
    await Promise.all([join(0), join(1)]);
    await run.wait(lateMs);
    await join(2);
  }
  await run.wait(holdMs);
  const evidence = { lateMs, holdMs, joins, guests: [] };
  for (const [index, page] of guests.pages.entries()) {
    const [samples, diagnostics] = await page.evaluate(() => [window.__stall, window.__pcDiag]);
    evidence.guests.push({ guest: index + 1, samples, diagnostics, network: guests.networks[index] });
  }
  await save(`${run.directory}/join-stall.json`, evidence);
  console.log(`join-stall evidence: ${run.directory}/join-stall.json`);
  await end();
  for (const page of guests.pages) await page.context().close();
  return { samples: evidence.guests.map((guest) => guest.samples.length) };
}
