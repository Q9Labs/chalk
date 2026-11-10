// Three real SDK/Chromium guests against a local node. No external services.
// Run from features/media/sfu: node tests/browser/sdk-guest-toggle-repro.mjs
// SFU_SOURCE_DIR selects a control node checkout; REPRO_ROUNDS defaults to three
// (mic-first, camera-first, staggered concurrent republish). Optional
// REPRO_EVIDENCE_DIR writes private SDP/stats/node logs; never commit that output.
// Uses the production FFT probe: ten consecutive post-unmute tone frames in 5 s.
// RTP/sample counters alone cannot prove the remote track produces audio.
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright";

import { cleanupHarness, createPki, startSfu } from "./harness.mjs";
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
const results = [];
if (evidence) mkdirSync(evidence, { recursive: true });
const children = [];
const nodeLines = [];
const failures = [];
const publishers = new Map();
const guests = [];
const immediateResponses = { publications: () => ({ status: 200, body: registrySnapshot() }) };
const operationRoutes = {
  tracks: (connectionId) => `/v1/sessions/${connectionId}/tracks`,
  tracks_close: (connectionId) => `/v1/sessions/${connectionId}/tracks/close`,
  renegotiate: (connectionId) => `/v1/sessions/${connectionId}/renegotiate`,
};
let browser;
let sequence = 0;
let rosterSequence = 0;
let rosterActive = false;

function logResponse(label, status, body, requestDescription) {
  recordSignalResponse(label, status, body, requestDescription);
  recordSignalFailures(label, status, body);
}

function recordSignalResponse(label, status, body, requestDescription) {
  const { sessionDescription, tracks, trackErrors } = body ?? {};
  results.push({ type: "signal", label, status, requestSDP: requestDescription?.sdp, responseSDP: sessionDescription?.sdp, tracks, errors: trackErrors });
}

function recordSignalFailures(label, status, body) {
  recordStatusFailure(label, status);
  recordTrackFailures(label, body);
}

function recordStatusFailure(label, status) {
  if (status === 200 || status === 204) return;
  failures.push(`${label}: status=${status}`);
}

function recordTrackFailures(label, body) {
  for (const error of trackErrors(body)) failures.push(`${label}: trackError=${error.errorCode}`);
}

function trackErrors(body) {
  return body?.trackErrors ?? [];
}

async function main() {
  const control = await startService(createPki(work, identity));
  const tenant = { tenantId: "tenant-sdk-toggle", episodeId: "episode-1", generation: 1 };
  const proofGuests = await prepareGuests(control, tenant);
  await verifyInitialAudio(proofGuests);
  await verifySilenceRejection(proofGuests);
  await runRounds(proofGuests);
  reportResult();
}

async function prepareGuests(control, tenant) {
  await createGuestSessions(control, tenant);
  await grantGuestSources(control, tenant);
  const bundle = await buildSdkBundle();
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  results.push({ type: "environment", chromium: browser.version(), rounds });
  for (const guest of guests) await startGuest(control, guest, bundle);
  await activateRoster();
  await waitForSnapshots((snapshot) => snapshot.remote.length === 4, 12_000, "initial four remote tracks per guest");
  return { pages: guests.map((guest) => guest.page), participants: guests.map((guest) => guest.scope.participantId), tones: true };
}

async function createGuestSessions(control, tenant) {
  for (let index = 0; index < 3; index++) {
    const scope = { ...tenant, participantId: `guest-${index + 1}` };
    const response = await control.post("/v1/sessions", { operationId: `create-${index}`, scope });
    if (response.status !== 200) throw new Error(`create session guest=${index + 1}: ${response.status}`);
    guests.push({ index, scope, connectionId: response.body.connectionId, page: null, started: false });
  }
}

async function grantGuestSources(control, tenant) {
  const controls = guests.flatMap(({ scope }) => ["microphone", "camera"].map((sourceName) => ({ participantId: scope.participantId, source: sourceName, action: "grant", revision: 1 })));
  const granted = await control.post("/v1/episodes/sources", { tenantId: tenant.tenantId, episodeId: tenant.episodeId, controls });
  if (granted.status !== 200) throw new Error(`grant sources: ${granted.status}`);
}

async function buildSdkBundle() {
  return build({
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
}

async function startGuest(control, guest, bundle) {
  const context = await browser.newContext();
  guest.page = await context.newPage();
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

      function assertSignalingSuccess(result) {
        if (result.status >= 400) throw new window.CloudflareSFUError(result.body?.message ?? `signaling failed with ${result.status}`, "signaling_failed", { status: result.status });
      }

      function applyRoster(result) {
        if (!result.roster) return;
        window.mediaRoster = result.roster;
        window.mediaClient.remotePublicationsChanged(result.roster);
      }

      function checked(result) {
        assertSignalingSuccess(result);
        applyRoster(result);
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

async function activateRoster() {
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
}

async function verifyInitialAudio(proofGuests) {
  await proveAudioDecoded(proofGuests, { timeoutMs: 12_000 });
  console.log("INITIAL all six pairs decode their speaker's tone");
  await record("initial");
}

async function verifySilenceRejection(proofGuests) {
  await guests[0].page.evaluate(async () => {
    await window.proofAudio.context.suspend();
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const negative = await hearAfterUnmute(proofGuests, 0, { turnedOnAt: Date.now(), timeoutMs: 1500 });
  if (negative.some((verdict) => verdict.pass)) throw new Error("decode probe accepted digital silence");
  await guests[0].page.evaluate(() => window.proofAudio.context.resume());
  await proveAudioDecoded(proofGuests, { timeoutMs: 5000 });
  console.log("NEGATIVE digital silence rejected by both listeners");
}

async function runRounds(proofGuests) {
  for (let round = 0; round < rounds; round++) {
    await runRound(round, proofGuests);
    if (failures.length) break;
  }
}

async function runRound(round, proofGuests) {
  const order = roundOrder(round);
  await record(`round-${round + 1}-before-off`);
  await turnOffGuests(order);
  await waitForSnapshots((snapshot) => snapshot.remote.length === 0, 8000, "all remote receivers retired");
  await record(`round-${round + 1}-off`);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const turnedOn = await turnOnGuests(round, order);
  await waitForSnapshots((snapshot) => snapshot.remote.length === 4, 15000, "remote tracks re-pulled");
  const before = await record(`round-${round + 1}-resumed`);
  const verdicts = await decodeAllPairs(proofGuests, turnedOn);
  const after = await record(`round-${round + 1}-decoded`);
  results.push({ type: "decode", round: round + 1, verdicts, before, after });
  reportVerdicts(round, verdicts);
  verifyCameraFrames(round, before, after);
}

function roundOrder(round) {
  return round % 3 === 1 ? ["camera", "microphone"] : ["microphone", "camera"];
}

async function turnOffGuests(order) {
  await Promise.all(guests.map((guest) => setGuestTargets(guest, order, false)));
}

async function setGuestTargets(guest, order, enabled) {
  for (const sourceName of order) await setTarget(guest, sourceName, enabled);
}

async function turnOnGuests(round, order) {
  const turnedOn = [];
  await Promise.all(guests.map((guest) => resumeGuest(guest, round, order, turnedOn)));
  return turnedOn;
}

async function resumeGuest(guest, round, order, turnedOn) {
  if (round % 3 === 2) await new Promise((resolve) => setTimeout(resolve, ((guest.index + round) % 3) * 80));
  for (const sourceName of order) {
    if (sourceName === "microphone") turnedOn[guest.index] = Date.now();
    await setTarget(guest, sourceName, true);
  }
}

async function decodeAllPairs(proofGuests, turnedOn) {
  return (await Promise.all(guests.map((guest) => hearAfterUnmute(proofGuests, guest.index, { turnedOnAt: turnedOn[guest.index] })))).flat();
}

function reportVerdicts(round, verdicts) {
  for (const verdict of verdicts) {
    console.log(`DECODE round=${round + 1} pair=${verdict.listener}->${verdict.speaker} pass=${verdict.pass} peakDb=${verdict.peakDb} sustained=${verdict.sustainedFrames}`);
    if (!verdict.pass) failures.push(`round=${round + 1} pair=${verdict.listener}->${verdict.speaker} no decoded tone`);
  }
}

function verifyCameraFrames(round, before, after) {
  for (const [guestIndex, state] of after.entries()) {
    for (const track of state.remote.filter((item) => item.source === "camera")) {
      const previous = before[guestIndex].remote.find((item) => item.participantId === track.participantId && item.source === "camera");
      if (!hasNewDecodedFrames(track, previous)) failures.push(`round=${round + 1} guest=${guestIndex + 1} camera from ${track.participantId} no decoded frames`);
    }
  }
}

function hasNewDecodedFrames(track, previous) {
  return track.stats.some((stat) => stat.framesDecoded > previousFrames(previous, stat.ssrc));
}

function previousFrames(previous, ssrc) {
  return previous?.stats.find((item) => item.ssrc === ssrc)?.framesDecoded ?? 0;
}

function reportResult() {
  console.log(`RESULT ${failures.length ? `FAIL ${JSON.stringify(failures)}` : `PASS ${rounds} rounds, six audio and video pairs per round`}`);
  if (failures.length) process.exitCode = 1;
}

async function record(label) {
  const states = await Promise.all(
    guests.map((guest) =>
      guest.page.evaluate(async () => {
        const pc = window.sfuPC;
        const remote = await Promise.all(
          window.mediaClient.getSnapshot().remoteTracks.map(async (track) => {
            const transceiver = pc.getTransceivers().find((t) => t.receiver.track === track.track);
            const stats = transceiver ? [...(await transceiver.receiver.getStats()).values()].filter((s) => s.type === "inbound-rtp") : [];
            return { participantId: track.participantId, source: track.source, mid: transceiver?.mid, readyState: track.track.readyState, enabled: track.track.enabled, muted: track.track.muted, stats };
          }),
        );
        return {
          remote,
          localSDP: pc.localDescription?.sdp,
          remoteSDP: pc.remoteDescription?.sdp,
          transceivers: pc.getTransceivers().map((t) => ({ mid: t.mid, direction: t.direction, currentDirection: t.currentDirection, receiverId: t.receiver.track.id, muted: t.receiver.track.muted, readyState: t.receiver.track.readyState })),
          events: window.sfuEvents,
          errors: window.sfuErrors,
        };
      }),
    ),
  );
  results.push({ type: "state", label, states });
  return states;
}

async function setTarget(guest, sourceName, enabled) {
  const result = await guest.page.evaluate(
    async ({ source, enabled, participantId }) => {
      const started = performance.now();
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
      return { ...outcome, durationMs: performance.now() - started, snapshot: window.mediaClient.getSnapshot() };
    },
    { source: sourceName, enabled, participantId: guest.scope.participantId },
  );

  if (enabled && result.outcome !== "confirmed" && result.outcome !== "satisfied") failures.push(`guest=${guest.index + 1} ${sourceName}-on outcome=${result.outcome} code=${result.errorCode}`);
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
  results.push({ type: "timeout", label, latest });
  failures.push(`timed out: ${label}`);
  return latest;
}

function registrySnapshot() {
  return { incarnation: 1, sequence: rosterSequence, publications: [...publishers.values()].map(({ participantId, source, publicationId }) => ({ participantId, source, publicationId })) };
}

async function publishRosterToAll(exceptGuest) {
  const roster = registrySnapshot().publications.map((publication) => ({ ...publication, enabled: true }));
  await Promise.all(guests.filter((guest) => guest.started && guest !== exceptGuest).map((guest) => guest.page.evaluate((rows) => window.mediaClient.remotePublicationsChanged(rows), roster)));
}

async function bridge(control, guest, operation, input) {
  const respondImmediately = immediateResponses[operation];
  if (respondImmediately) return respondImmediately();
  const request = signalingRequest(guest, operation, input);
  const response = await control.post(routeFor(operation, guest.connectionId), request);
  const responseBody = response.body;
  logResponse(`${operation} guest=${guest.index + 1}`, response.status, responseBody, input.sessionDescription);
  updatePublisherRegistry(operation, response.status, guest, input, responseBody);
  publishUpdatedRoster(operation, input, guest);
  return bridgeResult(response.status, responseBody);
}

function signalingRequest(guest, operation, input) {
  const operationId = `sdk-${guest.index}-${++sequence}`;
  const { connectionId: _connectionId, allowPartialRemoteTracks: _partial, ...request } = input;
  if (operation === "tracks_close") request.tracks = (input.tracks ?? []).map(({ mid }) => ({ mid }));
  return { ...request, operationId, scope: guest.scope };
}

function bridgeResult(status, body) {
  const result = { status, body };
  if (rosterActive) result.roster = currentRoster();
  return result;
}

function currentRoster() {
  return registrySnapshot().publications.map((publication) => ({ ...publication, enabled: true }));
}

function publishUpdatedRoster(operation, input, guest) {
  if (shouldPublishRoster(operation, input)) void publishRosterToAll(guest);
}

function routeFor(operation, connectionId) {
  const route = operationRoutes[operation] ?? operationRoutes.renegotiate;
  return route(connectionId);
}

function updatePublisherRegistry(operation, status, guest, input, responseBody) {
  if (status !== 200) return;
  const update = publisherRegistryUpdates[operation];
  if (update) update(guest, input, responseBody);
}

const publisherRegistryUpdates = {
  tracks: (guest, input, body) => registerPublishedTracks(guest, input.tracks ?? [], body),
  tracks_close: (guest, input) => removeTracksUnlessReceiveOnly(guest, input),
};

function removeTracksUnlessReceiveOnly(guest, input) {
  if (!input.receiveOnly) removeClosedTracks(guest, input.tracks ?? []);
}

function registerPublishedTracks(guest, tracks, responseBody) {
  for (const track of tracks) registerPublishedTrack(guest, track, responseBody);
}

function registerPublishedTrack(guest, track, responseBody) {
  if (track.location !== "local") return;
  const returned = responseBody?.tracks?.find((item) => item.mid === track.mid && item.trackName === track.trackName);
  if (!returned) return;
  const publicationId = `${guest.connectionId}|${track.trackName}`;
  publishers.set(publicationId, { participantId: guest.scope.participantId, source: track.source, publicationId, connectionId: guest.connectionId, trackName: track.trackName, mid: track.mid });
  responseBody.tracks = responseBody.tracks.map((item) => (item.mid === track.mid && item.trackName === track.trackName ? { ...item, publicationId } : item));
  rosterSequence++;
}

function removeClosedTracks(guest, tracks) {
  for (const track of tracks) removeClosedTrack(guest, track);
}

function removeClosedTrack(guest, track) {
  const found = [...publishers].find(([, publication]) => publication.connectionId === guest.connectionId && publication.mid === track.mid);
  if (found) publishers.delete(found[0]);
  rosterSequence++;
}

function shouldPublishRoster(operation, input) {
  return rosterActive && (operation !== "tracks_close" || !input.receiveOnly);
}

async function startService(certs) {
  const sourceDir = process.env.SFU_SOURCE_DIR ?? process.cwd();
  const control = await startSfu({
    work,
    sourceDir,
    certs,
    identity,
    children,
    stdio: ["ignore", "pipe", "pipe"],
    onOutput(stream) {
      stream.setEncoding("utf8").on("data", (data) => nodeLines.push(...data.split(/\r?\n/).filter(Boolean)));
    },
  });
  await waitForReady(control, 15_000);
  return control;
}

async function waitForReady(control, timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await control.get("/readyz").catch(() => ({ status: 0 }))).status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("SFU did not become ready");
}

async function saveEvidence() {
  if (evidence) {
    writeFileSync(path.join(evidence, "browser.json"), JSON.stringify(results));
    writeFileSync(path.join(evidence, "node.log"), nodeLines.join("\n"));
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message.replace(/https?:\/\/\S+/g, "<endpoint>"));
  process.exitCode = 1;
} finally {
  await cleanupHarness({ browser, children, work, beforeCleanup: saveEvidence });
}
