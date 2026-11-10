// Three real SDK/Chromium guests against a local node. No external services.
// Run from features/media/sfu: node tests/browser/sdk-guest-toggle-repro.mjs
// SFU_SOURCE_DIR selects a control node checkout; REPRO_ROUNDS defaults to three.
// REPRO_VARIANT is mic-only, mic-camera, or single-guest-mic. REPRO_MEASURE_ONLY=1
// skips repeated decode probes while retaining the real SDK/Chromium/node path.
// REPRO_EVIDENCE_DIR writes sanitized local metrics; never commit that output.
// Uses the production FFT probe: ten consecutive post-unmute tone frames in 5 s.
// RTP/sample counters alone cannot prove the remote track produces audio.
import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { installFixture } from "../../../../../scripts/prod-proof/fixture.mjs";
import { hearAfterUnmute, proveAudioDecoded } from "../../../../../scripts/prod-proof/audio-decode.mjs";

const identity = "chalk-api.test";
const root = path.resolve(process.cwd(), "../../..");
const source = path.join(root, "sdks/typescript/client/src/media/client.ts");
const requireSDK = createRequire(path.join(root, "sdks/typescript/client/package.json"));
const { build } = requireSDK("esbuild");
const work = mkdtempSync(path.join(tmpdir(), "sfu-sdk-toggle-"));
const evidence = process.env.REPRO_EVIDENCE_DIR;
const rounds = Number(process.env.REPRO_ROUNDS ?? 3);
const variant = process.env.REPRO_VARIANT ?? "mic-camera";
const measureOnly = process.env.REPRO_MEASURE_ONLY === "1";
const validVariants = new Set(["mic-only", "mic-camera", "single-guest-mic"]);
if (!validVariants.has(variant)) throw new Error(`REPRO_VARIANT must be one of ${[...validVariants].join(", ")}`);
const results = [];
if (evidence) mkdirSync(evidence, { recursive: true });
const children = [];
const nodeLines = [];
const failures = [];
const publishers = new Map();
const guests = [];
let browser;
let sequence = 0;
let rosterSequence = 0;
let rosterActive = false;
let activeRound = 0;
let activePhase = "setup";

function sectionCounts(sdp) {
  const matches = sdp?.match(/^m=(audio|video)\s/gm) ?? [];
  const audio = matches.filter((line) => line.startsWith("m=audio ")).length;
  const video = matches.length - audio;
  return { audio, video, total: matches.length };
}

function bytesOf(sdp) {
  return sdp == null ? null : Buffer.byteLength(sdp, "utf8");
}

function toggledSourcesForRound(round) {
  if (variant === "mic-only" || variant === "single-guest-mic") return ["microphone"];
  return round % 3 === 1 ? ["camera", "microphone"] : ["microphone", "camera"];
}

function guestTogglesSource(guest, source) {
  return variant !== "single-guest-mic" || (guest.index === 0 && source === "microphone");
}

function refusalCode(status, errors, body) {
  const code = errors.find((error) => error.code === "limit_exceeded")?.code ?? body?.code;
  if (code && /^[a-z_]+$/.test(code)) return code;
  if (status === 403) return "forbidden";
  if (status === 429) return "capacity_exceeded";
  return status >= 400 ? "http_refusal" : null;
}

function logResponse(guest, operation, status, body, requestDescription, replacementCause) {
  const description = body?.sessionDescription;
  const offer = requestDescription?.type === "offer" ? sectionCounts(requestDescription.sdp) : null;
  const answered = sectionCounts(description?.sdp);
  if (description?.sdp) guest.nodeSections = answered;
  const errors = (body?.trackErrors ?? []).map((error) => ({ code: error.code ?? error.errorCode ?? "unknown" }));
  const refusal = refusalCode(status, errors, body);
  const row = {
    type: "signal",
    variant,
    round: activeRound,
    phase: activePhase,
    guest: guest.index + 1,
    connectionGeneration: guest.connectionGeneration,
    operation,
    status,
    offerBytes: offer ? bytesOf(requestDescription.sdp) : null,
    offerSections: offer,
    nodeSections: { ...guest.nodeSections },
    refusal,
    replacementCause: replacementCause ?? null,
    trackErrors: errors,
  };
  results.push(row);
  if (replacementCause) {
    const replacement = results.findLast((item) => item.type === "replacement" && item.guest === guest.index + 1 && item.connectionGeneration === guest.connectionGeneration);
    if (replacement) {
      replacement.sdkCause = replacementCause;
      replacement.reason = replacementCause === "section_budget" ? "offer_size" : replacementCause;
      console.log(`REPLACEMENT_CAUSE variant=${variant} round=${replacement.round} guest=${replacement.guest} generation=${replacement.connectionGeneration} sdkCause=${replacementCause}`);
    }
  }
  if (!measureOnly && status !== 200 && status !== 204) failures.push(`guest=${guest.index + 1} ${operation}: status=${status}`);
  if (!measureOnly) for (const error of errors) failures.push(`guest=${guest.index + 1} ${operation}: trackError=${error.code}`);
}

async function main() {
  const certs = createPki(work);
  const control = await startService(certs);
  const tenant = { tenantId: "tenant-sdk-toggle", episodeId: "episode-1", generation: 1 };
  for (let index = 0; index < 3; index++) {
    const scope = { ...tenant, participantId: `guest-${index + 1}` };
    const response = await control.post("/v1/sessions", { operationId: `create-${index}`, scope });
    if (response.status !== 200) throw new Error(`create session guest=${index + 1}: ${response.status}`);
    guests.push({ index, scope, connectionId: response.body.connectionId, connectionGeneration: 1, nodeSections: { audio: 0, video: 0, total: 0 }, page: null, started: false, lastOfferTrigger: null });
  }
  const controls = guests.flatMap(({ scope }) => ["microphone", "camera"].map((sourceName) => ({ participantId: scope.participantId, source: sourceName, action: "grant", revision: 1 })));
  const granted = await control.post("/v1/episodes/sources", { tenantId: tenant.tenantId, episodeId: tenant.episodeId, controls });
  if (granted.status !== 200) throw new Error(`grant sources: ${granted.status}`);

  const bundle = await build({
    stdin: {
      contents: `import { CloudflareSFUClient } from ${JSON.stringify(source)}; import { CloudflareSFUError } from ${JSON.stringify(path.join(root, "sdks/typescript/client/src/media/types.ts"))}; window.CloudflareSFUClient = CloudflareSFUClient; window.CloudflareSFUError = CloudflareSFUError;`,
      resolveDir: root,
      sourcefile: "guest-sdk-entry.ts",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
  });
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  results.push({ type: "environment", chromium: browser.version(), rounds, variant, measureOnly });
  for (const guest of guests) {
    const context = await browser.newContext();
    guest.page = await context.newPage();
    guest.page.on("console", (message) => {
      const match = message.text().match(/replacing the media connection because its next offer is (\d+) bytes \((\d+) in closed or parked sections\)/);
      if (!match) return;
      const event = { type: "sdk_offer_trigger", variant, round: activeRound, phase: activePhase, guest: guest.index + 1, offerBytes: Number(match[1]), reclaimableBytes: Number(match[2]), connectionGeneration: guest.connectionGeneration };
      guest.lastOfferTrigger = event;
      results.push(event);
    });
    await guest.page.route("http://localhost/", (route) => route.fulfill({ contentType: "text/html", body: "<title>local SDK media repro</title>" }));
    await guest.page.goto("http://localhost/");
    await guest.page.evaluate(installFixture, { guest: guest.index, tones: true });
    await guest.page.addScriptTag({ content: bundle.outputFiles[0].text });
    await guest.page.exposeFunction("sfuBridge", (operation, input) => bridge(control, guest, operation, input));
    await guest.page.evaluate(
      async ({ connectionId, participantId }) => {
        window.sfuEvents = [];
        window.sfuErrors = [];
        window.mediaRoster = [];
        window.proofClient = { getSnapshot: () => ({ media: { remote: window.mediaClient.getSnapshot().remoteTracks } }) };
        window.mediaClient = new window.CloudflareSFUClient({
          bootstrap: {
            connectionId,
            iceServers: [],
            capabilities: { serverLayerAdaptation: false, subscriptionState: false, iceRestart: false, pullPublished: false, unifiedSignaling: false, muteInPlace: false },
          },
          participantId,
          replaceMediaConnection: async () => {
            const result = await window.sfuBridge("replace", {});
            if (result.status >= 400) throw new window.CloudflareSFUError("local session replacement failed", "signaling_failed", { status: result.status });
            return {
              connectionId: result.body.connectionId,
              iceServers: [],
              capabilities: { serverLayerAdaptation: false, subscriptionState: false, iceRestart: false, pullPublished: false, unifiedSignaling: false, muteInPlace: false },
            };
          },
          pollIntervalMs: 15_000,
          unreportedVideoTileWaitMs: 0,
          peerConnectionFactory(configuration) {
            const pc = (window.sfuPC = new RTCPeerConnection(configuration));
            pc.addEventListener("track", (event) => window.sfuEvents.push({ type: "track", mid: event.transceiver.mid, kind: event.track.kind, id: event.track.id, readyState: event.track.readyState }));
            return pc;
          },
          onRemoteTrack(publication) {
            window.sfuEvents.push({ type: "remote-publication", participantId: publication.participantId, source: publication.source, publicationId: publication.publicationId, kind: publication.track.kind, id: publication.track.id });
          },
          onError(error) {
            window.sfuErrors.push({ name: error.name, message: error.message, code: error.code, status: error.options?.status });
          },
          onDiagnostic(event) {
            window.sfuEvents.push({ type: "diagnostic", ...event });
          },
          transport: {
            async addTracks(input) {
              return checked(await window.sfuBridge("tracks", input));
            },
            async closeTracks(input) {
              return checked(await window.sfuBridge("tracks_close", input));
            },
            async renegotiate(input) {
              checked(await window.sfuBridge("renegotiate", input));
            },
            async listPublications() {
              return checked(await window.sfuBridge("publications", {}));
            },
          },
        });
        window.mediaClient.remoteParticipantsChanged([]);
        function checked(result) {
          if (result.status >= 400) throw new window.CloudflareSFUError(result.body?.message ?? `signaling failed with ${result.status}`, "signaling_failed", { status: result.status });
          if (result.roster) {
            window.mediaRoster = result.roster;
            window.mediaClient.remotePublicationsChanged(result.roster);
          }
          return result.body;
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: 1280, height: 720, frameRate: 30 } });
        await window.mediaClient.start(stream);
      },
      { connectionId: guest.connectionId, participantId: guest.scope.participantId },
    );
    guest.started = true;
    console.log(`SDK_START guest=${guest.index + 1} status=live`);
  }

  rosterActive = true;
  await publishRosterToAll();
  await Promise.all(
    guests.map((guest) =>
      guest.page.evaluate(
        (participantIds) => window.mediaClient.remoteParticipantsChanged(participantIds),
        guests.filter((other) => other !== guest).map((other) => other.scope.participantId),
      ),
    ),
  );
  await Promise.all(guests.map((guest) => guest.page.evaluate(() => window.mediaClient.refreshRemotePublications())));
  await waitForSnapshots((snapshot) => snapshot.remote.length === 4, 12_000, "initial four remote tracks per guest");
  const proofGuests = { pages: guests.map((g) => g.page), participants: guests.map((g) => g.scope.participantId), tones: true };
  await proveAudioDecoded(proofGuests, { timeoutMs: 12_000 });
  console.log("INITIAL all six pairs decode their speaker's tone");
  await record("initial");
  if (!measureOnly) {
    // A suspended tone source must fail the exact decode probe, even with a live receiver.
    await guests[0].page.evaluate(async () => {
      await window.proofAudio.context.suspend();
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const negative = await hearAfterUnmute(proofGuests, 0, { turnedOnAt: Date.now(), timeoutMs: 1500 });
    if (negative.some((v) => v.pass)) throw new Error("decode probe accepted digital silence");
    await guests[0].page.evaluate(() => window.proofAudio.context.resume());
    await proveAudioDecoded(proofGuests, { timeoutMs: 5000 });
    console.log("NEGATIVE digital silence rejected by both listeners");
  }

  const measurementStartedAt = Date.now();
  for (let round = 0; round < rounds; round++) {
    activeRound = round + 1;
    const order = toggledSourcesForRound(round);
    if (!measureOnly) await record(`round-${activeRound}-before-off`);
    activePhase = "off";
    await Promise.all(
      guests.map(async (guest) => {
        for (const source of order) if (guestTogglesSource(guest, source)) await setTarget(guest, source, false);
      }),
    );
    await waitForRoundSnapshots(expectedRemoteCounts(order, true), "remote tracks after off");
    if (!measureOnly) await record(`round-${activeRound}-off`);
    await new Promise((resolve) => setTimeout(resolve, 120));
    activePhase = "on";
    const turnedOn = [];
    await Promise.all(
      guests.map(async (guest) => {
        for (const source of order) {
          if (!guestTogglesSource(guest, source)) continue;
          if (source === "microphone") turnedOn[guest.index] = Date.now();
          await setTarget(guest, source, true);
        }
      }),
    );
    await waitForRoundSnapshots([4, 4, 4], "remote tracks after on");
    const before = measureOnly ? [] : await record(`round-${activeRound}-resumed`);
    if (!measureOnly) {
      const verdicts = (await Promise.all(guests.map((guest) => hearAfterUnmute(proofGuests, guest.index, { turnedOnAt: turnedOn[guest.index] })))).flat();
      const after = await record(`round-${activeRound}-decoded`);
      results.push({ type: "decode", round: activeRound, verdicts: verdicts.map(({ listener, speaker, pass, peakDb, sustainedFrames }) => ({ listener, speaker, pass, peakDb, sustainedFrames })) });
      for (const verdict of verdicts) {
        console.log(`DECODE round=${activeRound} pair=${verdict.listener}->${verdict.speaker} pass=${verdict.pass} peakDb=${verdict.peakDb} sustained=${verdict.sustainedFrames}`);
        if (!verdict.pass) failures.push(`round=${activeRound} pair=${verdict.listener}->${verdict.speaker} no decoded tone`);
      }
      for (let i = 0; i < after.length; i++) {
        for (const track of after[i].remote.filter((t) => t.source === "camera")) {
          const previous = before[i].remote.find((t) => t.participantId === track.participantId && t.source === "camera");
          if (!track.stats.some((stat) => stat.framesDecoded > (previous?.stats.find((old) => old.ssrc === stat.ssrc)?.framesDecoded ?? 0))) failures.push(`round=${activeRound} guest=${i + 1} camera from ${track.participantId} no decoded frames`);
        }
      }
    }
    const roundRows = results.filter((row) => row.type === "signal" && row.round === activeRound);
    const offerProbes = await Promise.all(
      guests.map((guest) =>
        guest.page.evaluate(async () => {
          const sdp = (await window.sfuPC.createOffer()).sdp ?? "";
          const mediaSections = sdp.match(/^m=(audio|video)\s/gm) ?? [];
          const audio = mediaSections.filter((line) => line.startsWith("m=audio ")).length;
          return { bytes: new TextEncoder().encode(sdp).length, sections: { audio, video: mediaSections.length - audio, total: mediaSections.length } };
        }),
      ),
    );
    for (const guest of guests) {
      const guestRows = roundRows.filter((row) => row.guest === guest.index + 1);
      const offers = guestRows.filter((row) => row.offerBytes !== null).map((row) => `${row.operation}:${row.offerBytes}`);
      const offersByRound = guestRows.filter((row) => row.offerBytes !== null).map((row) => ({ operation: row.operation, bytes: row.offerBytes, audio: row.offerSections.audio, video: row.offerSections.video }));
      const offerProbe = offerProbes[guest.index];
      results.push({ type: "offer_probe", variant, round: activeRound, guest: guest.index + 1, connectionGeneration: guest.connectionGeneration, offerBytes: offerProbe.bytes, sections: offerProbe.sections, nodeSections: { ...guest.nodeSections } });
      const sample = {
        type: "round_sample",
        variant,
        round: activeRound,
        guest: guest.index + 1,
        connectionGeneration: guest.connectionGeneration,
        offers: offersByRound,
        maxOfferBytes: offersByRound.length ? Math.max(...offersByRound.map((offer) => offer.bytes)) : null,
        offerProbeBytes: offerProbe.bytes,
        nodeSections: { ...guest.nodeSections },
        refusal: guestRows.some((row) => row.refusal !== null),
      };
      results.push(sample);
      console.log(
        `ROUND variant=${variant} round=${activeRound} guest=${guest.index + 1} offers=${offers.join(",") || "none"} probeBytes=${offerProbe.bytes} nodeSections=${guest.nodeSections.audio}a/${guest.nodeSections.video}v/${guest.nodeSections.total} total generation=${guest.connectionGeneration} refusal=${sample.refusal}`,
      );
    }
    if (failures.length) break;
  }
  const userErrors = await Promise.all(guests.map((guest) => guest.page.evaluate(() => ({ errors: window.sfuErrors.map(({ code, status }) => ({ code, status })), failureCode: window.mediaClient.getSnapshot().failure?.code ?? null }))));
  results.push({ type: "user_errors", byGuest: userErrors.map((entry, index) => ({ guest: index + 1, ...entry })) });
  const replacements = results.filter((row) => row.type === "replacement");
  const firstRefusal = results.find((row) => row.type === "signal" && row.refusal !== null);
  const samples = results.filter((row) => row.type === "round_sample");
  const completedRounds = samples.filter((row) => row.guest === 1).length;
  for (const guest of guests) {
    const guestSamples = samples.filter((row) => row.guest === guest.index + 1);
    const guestRefusal = results.find((row) => row.type === "signal" && row.guest === guest.index + 1 && row.refusal !== null);
    const guestLimitRefusal = results.find((row) => row.type === "signal" && row.guest === guest.index + 1 && row.refusal === "limit_exceeded");
    const guestReplacement = replacements.find((row) => row.guest === guest.index + 1);
    const first = results.find((row) => row.guest === guest.index + 1 && (row.type === "replacement" || (row.type === "signal" && row.refusal !== null)));
    const end = guestSamples.at(-1);
    const growth = sectionAndOfferGrowth(guestSamples.filter((sample) => sample.connectionGeneration === 1));
    const userFailure = userErrors[guest.index];
    const guestHadRefusal = Boolean(guestRefusal);
    const callbackReportedRefusal = userFailure.errors.some((error) => error.status >= 400 || error.code === "limit_exceeded" || error.code === "capacity_exceeded");
    const targetReportedRefusal = results.some((row) => row.type === "toggle" && row.guest === guest.index + 1 && (row.status >= 400 || row.errorCode === "limit_exceeded" || row.errorCode === "capacity_exceeded"));
    const userSawRefusal = guestHadRefusal && (callbackReportedRefusal || targetReportedRefusal || userFailure.failureCode === "limit_exceeded" || userFailure.failureCode === "capacity_exceeded");
    const firstDescription = first?.type === "replacement" ? `replacement:${first.reason}@${first.round}` : first ? `refusal:${first.refusal}@${first.round}` : `none-through-${completedRounds}`;
    console.log(
      `GUEST variant=${variant} guest=${guest.index + 1} first=${firstDescription} firstNodeRefusal=${guestRefusal ? `${guestRefusal.status}:${guestRefusal.refusal}@${guestRefusal.round}` : "none"} firstLimitExceeded=${guestLimitRefusal?.round ?? "none"} firstReplacement=${guestReplacement?.round ?? "none"} endSections=${end?.nodeSections.total ?? 0}/160 audio=${end?.nodeSections.audio ?? 0} video=${end?.nodeSections.video ?? 0} endOfferBytes=${end?.offerProbeBytes ?? "none"} lastOfferSentBytes=${end?.maxOfferBytes ?? "none"} offerTrigger=40960 firstConnectionGrowth=${growth.audio.toFixed(2)}a/${growth.video.toFixed(2)}v-sections_per_round offerProbeGrowth=${growth.offerBytes.toFixed(1)}bytes_per_round userSawRefusal=${userSawRefusal}`,
    );
  }
  const durationMs = Date.now() - measurementStartedAt;
  results.push({ type: "run_summary", variant, completedRounds, durationMs });
  const firstLimitRefusal = results.find((row) => row.type === "signal" && row.refusal === "limit_exceeded");
  console.log(
    `SUMMARY variant=${variant} completedRounds=${completedRounds} durationSeconds=${(durationMs / 1000).toFixed(1)} firstHttpRefusalRound=${firstRefusal?.round ?? "none"} firstLimitExceededRound=${firstLimitRefusal?.round ?? "none"} replacements=${replacements.length} nodeSectionLimit=160 offerTriggerBytes=40960 nodeOfferCapBytes=65536`,
  );
  console.log(`RESULT ${failures.length ? `FAIL ${JSON.stringify(failures)}` : measureOnly ? `MEASURED ${completedRounds} rounds` : `PASS ${rounds} rounds`}`);
  if (failures.length) process.exitCode = 1;
}

function expectedRemoteCounts(toggledSources, off) {
  return guests.map((guest) => {
    let count = 0;
    for (const other of guests) {
      if (other === guest) continue;
      for (const source of ["microphone", "camera"]) {
        const toggledOff = off && toggledSources.includes(source) && guestTogglesSource(other, source);
        if (!toggledOff) count++;
      }
    }
    return count;
  });
}

async function waitForRoundSnapshots(expectedCounts, label) {
  const roundRefused = results.some((row) => row.type === "signal" && row.round === activeRound && row.refusal !== null);
  if (measureOnly && roundRefused) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return snapshots();
  }
  return waitForSnapshots((snapshot, index) => snapshot.remote.length === expectedCounts[index], measureOnly ? 8_000 : 15_000, `${label}: ${expectedCounts.join(",")}`);
}

async function record(label) {
  const states = await Promise.all(
    guests.map((guest) =>
      guest.page.evaluate(async () => {
        const pc = window.sfuPC;
        const remote = await Promise.all(
          window.mediaClient.getSnapshot().remoteTracks.map(async (track) => {
            const transceiver = pc.getTransceivers().find((t) => t.receiver.track === track.track);
            const stats = transceiver ? [...(await transceiver.receiver.getStats()).values()].filter((s) => s.type === "inbound-rtp").map((s) => ({ ssrc: s.ssrc, framesDecoded: s.framesDecoded, bytesReceived: s.bytesReceived, packetsReceived: s.packetsReceived })) : [];
            return { participantId: track.participantId, source: track.source, readyState: track.track.readyState, stats };
          }),
        );
        const transceivers = pc.getTransceivers();
        return {
          remote,
          local: window.mediaClient.getSnapshot().localTracks.map((track) => ({ source: track.source, enabled: track.enabled })),
          browserSections: {
            audio: transceivers.filter((t) => t.receiver.track.kind === "audio").length,
            video: transceivers.filter((t) => t.receiver.track.kind === "video").length,
            total: transceivers.length,
          },
          errors: window.sfuErrors.map(({ code, status }) => ({ code, status })),
        };
      }),
    ),
  );
  results.push({ type: "state", label, states: states.map((state, index) => ({ guest: index + 1, remote: state.remote, local: state.local, browserSections: state.browserSections, nodeSections: { ...guests[index].nodeSections }, errors: state.errors })) });
  return states;
}

async function setTarget(guest, sourceName, enabled) {
  const result = await guest.page.evaluate(
    async ({ source, enabled, participantId }) => {
      const started = performance.now();
      try {
        const target = { operationId: `toggle-${source}-${enabled}-${Date.now()}`, participantId, source, enabled };
        if (!enabled) {
          await window.mediaClient.setLocalSourceIntent(source, false, "user_pause");
        } else {
          window.mediaClient.setLocalSourceIntent(source, true);
          if (source === "camera") {
            await window.mediaClient.clearPreparedLocalTrack("camera", { stopTrack: false });
            const capture = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } });
            window.mediaClient.prepareLocalTrack("camera", capture.getVideoTracks()[0]);
          }
        }
        const outcome = await window.mediaClient.setLocalPublicationTarget(target);
        return { ...outcome, durationMs: performance.now() - started };
      } catch (error) {
        return { outcome: "error", errorCode: error.code ?? (error instanceof AggregateError ? "aggregate_error" : "unknown"), status: error.options?.status ?? null, durationMs: performance.now() - started };
      }
    },
    { source: sourceName, enabled, participantId: guest.scope.participantId },
  );

  results.push({ type: "toggle", variant, round: activeRound, phase: activePhase, guest: guest.index + 1, source: sourceName, enabled, outcome: result.outcome, errorCode: result.errorCode ?? null, status: result.status ?? null });
  if (enabled && result.outcome !== "confirmed" && result.outcome !== "satisfied" && !measureOnly) failures.push(`guest=${guest.index + 1} ${sourceName}-on outcome=${result.outcome} code=${result.errorCode}`);
  return result;
}

async function snapshots() {
  return Promise.all(
    guests.map((guest) =>
      guest.page.evaluate(() => {
        const snapshot = window.mediaClient.getSnapshot();
        return {
          connection: snapshot.connection,
          local: snapshot.localTracks.map((track) => ({ source: track.source, enabled: track.enabled, publicationId: track.publicationId })),
          remote: snapshot.remoteTracks.map((track) => ({ participantId: track.participantId, source: track.source, publicationId: track.publicationId, readyState: track.track.readyState })),
          failure: snapshot.failure,
        };
      }),
    ),
  );
}

async function waitForSnapshots(predicate, timeoutMs, label) {
  const until = Date.now() + timeoutMs;
  let latest;
  while (Date.now() < until) {
    latest = await snapshots();
    if (latest.every(predicate)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  results.push({ type: "timeout", label, guests: latest?.map((snapshot, index) => ({ guest: index + 1, remoteCount: snapshot.remote.length, failure: snapshot.failure?.code ?? null })) ?? [] });
  if (!measureOnly) failures.push(`timed out: ${label}`);
  return latest;
}

function sectionAndOfferGrowth(samples) {
  return {
    audio: segmentedSlope(samples, (sample) => sample.nodeSections.audio),
    video: segmentedSlope(samples, (sample) => sample.nodeSections.video),
    offerBytes: segmentedSlope(samples, (sample) => sample.offerProbeBytes),
  };
}

function segmentedSlope(samples, valueOf) {
  const byGeneration = new Map();
  for (const sample of samples) {
    const value = valueOf(sample);
    if (value == null) continue;
    const rows = byGeneration.get(sample.connectionGeneration) ?? [];
    rows.push({ round: sample.round, value });
    byGeneration.set(sample.connectionGeneration, rows);
  }
  let weighted = 0;
  let intervals = 0;
  for (const rows of byGeneration.values()) {
    if (rows.length < 2) continue;
    const xMean = rows.reduce((sum, row) => sum + row.round, 0) / rows.length;
    const yMean = rows.reduce((sum, row) => sum + row.value, 0) / rows.length;
    const denominator = rows.reduce((sum, row) => sum + (row.round - xMean) ** 2, 0);
    if (denominator === 0) continue;
    const slope = rows.reduce((sum, row) => sum + (row.round - xMean) * (row.value - yMean), 0) / denominator;
    const span = rows.at(-1).round - rows[0].round;
    weighted += slope * span;
    intervals += span;
  }
  return intervals ? weighted / intervals : 0;
}

function registrySnapshot() {
  return { incarnation: 1, sequence: rosterSequence, publications: [...publishers.values()].map(({ participantId, source, publicationId }) => ({ participantId, source, publicationId })) };
}

async function publishRosterToAll(exceptGuest) {
  const roster = registrySnapshot().publications.map((publication) => ({ ...publication, enabled: true }));
  await Promise.all(guests.filter((guest) => guest.started && guest !== exceptGuest).map((guest) => guest.page.evaluate((rows) => window.mediaClient.remotePublicationsChanged(rows), roster)));
}

async function bridge(control, guest, operation, input) {
  if (operation === "publications") return { status: 200, body: registrySnapshot() };
  if (operation === "replace") {
    const oldConnectionId = guest.connectionId;
    const nodeSectionsBefore = { ...guest.nodeSections };
    const response = await control.post("/v1/sessions", { operationId: `sdk-replace-${guest.index}-${++sequence}`, scope: guest.scope });
    if (response.status !== 200) return { status: response.status, body: response.body };
    for (const [publicationId, publication] of publishers) if (publication.connectionId === oldConnectionId) publishers.delete(publicationId);
    guest.connectionId = response.body.connectionId;
    guest.connectionGeneration++;
    guest.nodeSections = { audio: 0, video: 0, total: 0 };
    const trigger = guest.lastOfferTrigger;
    guest.lastOfferTrigger = null;
    const replacement = {
      type: "replacement",
      variant,
      round: activeRound,
      phase: activePhase,
      guest: guest.index + 1,
      connectionGeneration: guest.connectionGeneration,
      reason: trigger?.round === activeRound ? "offer_size" : "unknown",
      sdkCause: null,
      offerBytes: trigger?.offerBytes ?? null,
      reclaimableBytes: trigger?.reclaimableBytes ?? null,
      nodeSectionsBefore,
    };
    results.push(replacement);
    rosterSequence++;
    if (rosterActive) await publishRosterToAll(guest);
    console.log(`REPLACEMENT variant=${variant} round=${activeRound} guest=${guest.index + 1} generation=${guest.connectionGeneration} reason=${replacement.reason} offerBytes=${replacement.offerBytes ?? "unknown"}`);
    return { status: 200, body: { connectionId: response.body.connectionId } };
  }
  const operationId = `sdk-${guest.index}-${++sequence}`;
  const { connectionId: _connectionId, allowPartialRemoteTracks: _partial, replacementCause, ...request } = input;
  if (operation === "tracks_close") request.tracks = (input.tracks ?? []).map(({ mid }) => ({ mid }));
  const body = { ...request, operationId, scope: guest.scope };
  const route = operation === "tracks" ? `/v1/sessions/${guest.connectionId}/tracks` : operation === "tracks_close" ? `/v1/sessions/${guest.connectionId}/tracks/close` : `/v1/sessions/${guest.connectionId}/renegotiate`;
  const response = await control.post(route, body);
  let responseBody = response.body;
  logResponse(guest, operation, response.status, responseBody, input.sessionDescription, replacementCause);

  if (operation === "tracks" && response.status === 200) {
    for (const track of input.tracks ?? []) {
      if (track.location !== "local") continue;
      const returned = responseBody?.tracks?.find((item) => item.mid === track.mid && item.trackName === track.trackName);
      if (!returned) continue;
      const publicationId = `${guest.connectionId}|${track.trackName}`;
      publishers.set(publicationId, { participantId: guest.scope.participantId, source: track.source, publicationId, connectionId: guest.connectionId, trackName: track.trackName, mid: track.mid });
      responseBody.tracks = responseBody.tracks.map((item) => (item.mid === track.mid && item.trackName === track.trackName ? { ...item, publicationId } : item));
      rosterSequence++;
    }
  }
  if (operation === "tracks_close" && response.status === 200 && !input.receiveOnly) {
    for (const item of input.tracks ?? []) {
      const found = [...publishers].find(([, publication]) => publication.connectionId === guest.connectionId && publication.mid === item.mid);
      if (found) publishers.delete(found[0]);
      rosterSequence++;
    }
  }
  const roster = registrySnapshot().publications.map((publication) => ({ ...publication, enabled: true }));
  if (rosterActive && (operation !== "tracks_close" || !input.receiveOnly)) void publishRosterToAll(guest);
  return { status: response.status, body: responseBody, ...(rosterActive ? { roster } : {}) };
}

async function startService(certs) {
  const binary = path.join(work, "sfu");
  const sourceDir = process.env.SFU_SOURCE_DIR ?? process.cwd();
  execFileSync("go", ["build", "-o", binary, "./cmd/sfu"], { cwd: sourceDir, stdio: "inherit" });
  const controlPort = await freeTcpPort();
  const udpPort = await freeUdpPort();
  const sfu = spawn(binary, [], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      SFU_CONTROL_ADDR: `127.0.0.1:${controlPort}`,
      SFU_UDP_ADDR: `127.0.0.1:${udpPort}`,
      SFU_ANNOUNCE_IPS: "127.0.0.1",
      SFU_ICE_LOOPBACK: "true",
      SFU_TLS_CERT_FILE: certs.server.cert,
      SFU_TLS_KEY_FILE: certs.server.key,
      SFU_CLIENT_CA_FILE: certs.ca,
      SFU_CLIENT_IDENTITY: identity,
      SFU_SOURCE_LEASE_TTL: "2m",
    },
  });
  for (const stream of [sfu.stdout, sfu.stderr]) stream.setEncoding("utf8").on("data", (data) => nodeLines.push(...data.split(/\r?\n/).filter(Boolean)));
  children.push(sfu);
  const control = controlClient(controlPort, certs);
  await waitForReady(control, 15_000);
  return control;
}

function createPki(directory) {
  const run = (...args) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "inherit"] });
  const ca = { key: path.join(directory, "ca.key"), cert: path.join(directory, "ca.pem") };
  run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", ca.key);
  run("req", "-new", "-x509", "-key", ca.key, "-sha256", "-days", "1", "-subj", "/CN=sfu-browser-ca", "-out", ca.cert, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  const issue = (name, san, usage) => {
    const files = { key: path.join(directory, `${name}.key`), csr: path.join(directory, `${name}.csr`), cert: path.join(directory, `${name}.pem`), ext: path.join(directory, `${name}.ext`) };
    run("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", files.key);
    run("req", "-new", "-key", files.key, "-subj", `/CN=${name}`, "-out", files.csr);
    writeFileSync(files.ext, `subjectAltName=${san}\nextendedKeyUsage=${usage}\nkeyUsage=digitalSignature\n`);
    run("x509", "-req", "-in", files.csr, "-CA", ca.cert, "-CAkey", ca.key, "-CAcreateserial", "-days", "1", "-sha256", "-extfile", files.ext, "-out", files.cert);
    return { key: files.key, cert: files.cert };
  };
  return { ca: ca.cert, server: issue("server", "DNS:localhost,IP:127.0.0.1", "serverAuth"), client: issue("client", `DNS:${identity}`, "clientAuth") };
}

function controlClient(port, certs) {
  const options = { host: "127.0.0.1", port, servername: "localhost", ca: readFileSync(certs.ca), cert: readFileSync(certs.client.cert), key: readFileSync(certs.client.key) };
  const send = (method, route, body) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const request = https.request({ ...options, method, path: route, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({ status: response.statusCode, body: text ? JSON.parse(text) : undefined });
        });
      });
      request.on("error", reject);
      request.end(payload);
    });
  return { get: (route) => send("GET", route), post: (route, body) => send("POST", route, body) };
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function freeUdpPort() {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", reject);
    socket.bind(0, "127.0.0.1", () => {
      const { port } = socket.address();
      socket.close(() => resolve(port));
    });
  });
}

async function waitForReady(control, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await control.get("/readyz").catch(() => ({ status: 0 }))).status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SFU did not become ready");
}

async function cleanup() {
  if (evidence) {
    writeFileSync(path.join(evidence, "browser.json"), JSON.stringify(results));
    const safeNodeLines = nodeLines.filter((line) => /refus|limit|too many media sections|offer.*larger/i.test(line)).map((line) => line.replace(/connectionId[=: ]+[^ ,}"\]]+/gi, "connectionId=<redacted>").replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<address>"));
    writeFileSync(path.join(evidence, "node.log"), safeNodeLines.join("\n"));
  }
  await browser?.close().catch(() => undefined);
  for (const child of children) {
    child.kill("SIGTERM");
    await new Promise((resolve) => (child.exitCode === null ? child.once("exit", resolve) : resolve()));
  }
  rmSync(work, { recursive: true, force: true });
}

try {
  await main();
} catch (error) {
  console.error(error.message.replace(/https?:\/\/\S+/g, "<endpoint>"));
  process.exitCode = 1;
} finally {
  await cleanup();
}
