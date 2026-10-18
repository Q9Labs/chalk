import { contactSheetFont } from "./contact-sheet.mjs";
import { recordingRejoinWindow } from "./recording-rejoin.mjs";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generateVoice } from "./fixture.mjs";
import { launchGuests, stats, limitCamera, restoreCamera, proveLayers } from "./media.mjs";
import { check, command, request, save, saveOwnership, waitFor } from "./runtime.mjs";
import { proofServer, exposeWebhook, proveWebhookEvents } from "./webhooks.mjs";

export async function prepareIntegration(run, webhooks) {
  run.signal.throwIfAborted();
  const key = await run.ownerRequest("POST", `${run.tenantPath}/api-keys`, {
    name: run.label,
    scopes: ["spaces:read", "spaces:write", "episodes:read", "episodes:write", "recordings:read", "transcriptions:read", "transcriptions:write"],
    expires_at: new Date(Date.now() + 55 * 60 * 1000).toISOString(),
  });
  run.ownership = { keyId: key.api_key.id };
  run.apiKey = key.secret;
  await saveOwnership(run);
  run.apiRequest = (method, path, body) => request(run.config, method, path, body, { Authorization: `Bearer ${run.apiKey}` }, {}, run.signal);
  const denied = await fetch(new URL(run.tenantPath, run.config.api_url), {
    headers: { Authorization: `Bearer ${run.apiKey}` },
    signal: AbortSignal.timeout(30_000),
  });
  await denied.body?.cancel();
  check(denied.status === 403, "Proof key unexpectedly has Tenant administration access");
  const receiver = await proofServer(run);
  if (webhooks) await exposeWebhook(run, receiver);
  return receiver;
}
async function createSpace(run) {
  const space = await run.apiRequest("POST", `${run.tenantPath}/spaces`, {
    name: run.label,
    slug: `prod-proof-${randomUUID()}`,
    metadata: { proof_run_id: run.runId },
    media_plane: "cf_sfu",
    recording_policy: "manual",
    transcription_policy: "on_demand",
    default_episode_duration_seconds: 1800,
    maximum_episode_duration_seconds: 1800,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
  });
  check(space.recording_policy === "manual", "Space Recording policy was not applied");
  check(space.transcription_policy === "on_demand", "Space Transcription policy was not applied");
  await save(`${run.directory}/space.json`, space);
  return space;
}
export function episodeEnd(run, path) {
  let ended = false;
  const ownerEnd = () => run.ownerRequest("POST", `${path}/end`, {});
  let endRequest = ownerEnd;
  const end = async () => {
    if (!ended) {
      await endRequest();
      ended = true;
    }
    await waitFor("proof Episode ended", async () => (await run.ownerRequest("GET", path)).status === "ended", 120_000);
  };
  return {
    end,
    useSDK: (page) => {
      endRequest = async () => {
        try {
          await page.evaluate(() => window.proofClient.endEpisode());
        } catch {
          // A dead guest must not prevent owner-authorized lifecycle cleanup.
          await ownerEnd();
        }
      };
    },
  };
}
async function createEpisode(run, space) {
  const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: run.runId } });
  const ending = episodeEnd(run, `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`);
  await save(`${run.directory}/episode.json`, episode);
  const policy = episode.config_snapshot.artifact_policy;
  check(policy.transcription.mode === "on_demand", "Episode effective transcription policy is not on_demand");
  check(policy.recording.mode === "manual", "Episode effective Recording policy is not manual");
  return { episode, ...ending };
}
async function startCapture(run, pages) {
  const started = await pages[0].evaluate(() => window.proofClient.recording.start());
  check(started.recordingId, "Recording start returned no Recording");
  run.recordingId = started.recordingId;
  await save(`${run.directory}/recording-start.json`, started);
  console.log("Recording acknowledged; waiting for Capture readiness");
  await waitFor(
    "Capture ready",
    async () => {
      const current = await pages[0].evaluate(() => window.proofClient.getSnapshot().recording.current);
      if (!current) return false;
      check(current.status !== "failed", "Capture failed before readiness");
      return current.recordingId === run.recordingId && current.status === "recording";
    },
    180_000,
    3000,
    run.signal,
  );
  console.log("Capture ready; collecting media evidence");
}
function statsSampler(run, pages) {
  const samples = [];
  let pending = Promise.resolve();
  const sample = async (phase) => {
    const value = await stats(pages);
    samples.push({ phase, at: new Date().toISOString(), guests: value });
    await save(`${run.directory}/webrtc-stats.json`, samples);
    return value;
  };
  return (phase) => {
    pending = pending.then(() => sample(phase));
    return pending;
  };
}
async function baselineLayers(run, sample) {
  await run.wait(10_000);
  const before = await sample("baseline-start");
  await run.wait(5000);
  const after = await sample("baseline-end");
  try {
    await proveLayers(run, { before, after });
  } catch (error) {
    return error.message;
  }
}
async function forceSwitch(run, pages, sample, receiveBefore) {
  await save(`${run.directory}/sender-limit.json`, await limitCamera(pages[0]));
  await run.wait(15_000); // Drain queued upper-layer packets before measuring activity.
  const before = await sample("limited-start");
  await run.wait(15_000);
  const after = await sample("limited-end");
  let failure;
  try {
    await proveLayers(run, { before, after, limited: true, receiveBefore });
  } catch (error) {
    failure = error.message;
  }
  await restoreCamera(pages[0]);
  console.log("Sender bandwidth restored; layer-switch evidence collected");
  return failure;
}
export function checkShareProgress(before, after) {
  const screens = after.filter((row) => row.source === "screen");
  const advancing = screens.some((row) => before.some((previous) => previous.id === row.id && previous.connection === row.connection && row.framesDecoded - previous.framesDecoded >= 2));
  check(advancing, "Screen-share decoding stalled during a ten-second observation window");
}
async function monitorShare(run, sample) {
  let before = await waitFor(
    "screen-share decoded frames",
    async () => {
      const value = await sample("share-ready");
      return value[1].some((row) => row.source === "screen" && row.framesDecoded > 0) ? value : false;
    },
    30_000,
    1000,
    run.signal,
  );
  const started = Date.now();
  for (let window = 1; window <= 12; window++) {
    await run.wait(10_000);
    const after = await sample(`share-window-${window}`);
    checkShareProgress(before[1], after[1]);
    before = after;
  }
  return (Date.now() - started) / 1000;
}
async function cameraShareWindow(run, pages, sample, origin, forceLayerSwitch) {
  const share = await pages[0].context().newPage();
  await share.goto(`${origin}/share`);
  await pages[0].bringToFront();
  await pages[0].evaluate(() => window.proofClient.media.setScreenShareEnabled(true));
  await waitFor("screen share enabled", () => pages[0].evaluate(() => window.proofClient.getSnapshot().media.screenShare.state === "enabled"));
  console.log("Screen share enabled; holding for two minutes");
  // Collect continuous receiving evidence independently of the camera limit.
  const monitor = monitorShare(run, sample).then(
    (seconds) => ({ seconds }),
    (error) => ({ error }),
  );
  await run.wait(30_000);
  const before = await sample("before-limit");
  let failure;
  if (forceLayerSwitch) failure = await forceSwitch(run, pages, sample, before);
  const observed = await monitor;
  if (observed.error) throw observed.error;
  await pages[0].evaluate(() => window.proofClient.media.setScreenShareEnabled(false));
  await share.close();
  return { seconds: observed.seconds, failure };
}
async function finalizedSource(run) {
  const recording = await waitFor(
    "Recording source",
    async () => {
      const value = await run.apiRequest("GET", `${run.tenantPath}/recordings/${run.recordingId}`);
      await save(`${run.directory}/recording.json`, value);
      check(!["failed", "expired"].includes(value.source.status), `Recording source ${value.source.status}`);
      return value.source.status === "available" ? value : false;
    },
    180_000,
    5000,
    run.signal,
  );
  check(recording.transcription_policy === "on_demand", "Recording effective transcription policy is disabled");
  return recording;
}
function cameraResult(share, baselineError, forceLayerSwitch) {
  const error = baselineError ?? share.failure;
  const result = { guests: 2, simulcast: !baselineError, shareSeconds: share.seconds, forcedLayerSwitch: forceLayerSwitch && !error };
  if (error) result.error = error;
  return result;
}
async function shortRecordingWindow(run, guests, rejoin) {
  if (rejoin) await recordingRejoinWindow(run, guests);
  else await run.wait(5000);
}
export async function recordProof(run, receiver, cameraShare, forceLayerSwitch, rejoin = false) {
  const space = await createSpace(run);
  const { episode, end, useSDK } = await createEpisode(run, space);
  run.episodeId = episode.id;
  console.log("Joining two synthetic camera/voice guests");
  const guests = await launchGuests(run, space, episode, rejoin ? null : await generateVoice(run.directory, run.signal), receiver.origin, rejoin);
  const { pages } = guests;
  useSDK(pages[0]);
  await startCapture(run, pages);
  const sample = statsSampler(run, pages);
  const baselineError = await baselineLayers(run, sample);
  let share = { seconds: 0 };
  if (cameraShare) share = await cameraShareWindow(run, pages, sample, receiver.origin, forceLayerSwitch);
  else await shortRecordingWindow(run, guests, rejoin);
  // End the active Episode once; its lifecycle stops Capture and finalizes the Recording.
  console.log("Ending own Episode and its active Recording");
  await end();
  const recording = await finalizedSource(run);
  for (const page of pages) await page.context().close();
  return { recording, camera: cameraResult(share, baselineError, forceLayerSwitch) };
}
export async function exportProof(run, execute = command) {
  const started = Date.now();
  await run.apiRequest("POST", `${run.tenantPath}/recordings/${run.recordingId}/export`, {});
  console.log("Export requested");
  await waitFor(
    "Export completion",
    async () => {
      const value = await run.apiRequest("GET", `${run.tenantPath}/recordings/${run.recordingId}`);
      await save(`${run.directory}/export-state.json`, value);
      check(!["failed", "unavailable"].includes(value.export.status), `Export ${value.export.status}: ${value.export.failure_code ?? "unknown"}`);
      return value.export.status === "ready";
    },
    240_000,
    5000,
    run.signal,
  );
  const wallSeconds = (Date.now() - started) / 1000;
  // Download immediately; one minute stays below the API artifact URL cap.
  const download = await run.apiRequest("POST", `${run.tenantPath}/recordings/${run.recordingId}/download-url`, { expires_in_seconds: 60 });
  const response = await fetch(download.url, { headers: download.signed_headers ?? {}, signal: AbortSignal.timeout(120_000) });
  check(response.ok, `MP4 download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  check(bytes.length > 1024 && bytes.subarray(4, 8).toString() === "ftyp", "Download is not an MP4");
  const mp4 = `${run.directory}/export.mp4`;
  await writeFile(mp4, bytes, { mode: 0o600 });
  const probe = JSON.parse(await execute("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", mp4]));
  check(
    probe.streams.some((stream) => stream.codec_type === "video" && stream.width >= 640 && stream.height >= 360),
    "Export has no usable video",
  );
  check(
    probe.streams.some((stream) => stream.codec_type === "audio"),
    "Export has no audio",
  );
  const duration = Number(probe.format.duration);
  check(duration >= 10, "Export is unexpectedly short");
  const frames = [];
  for (let index = 0; index < 4; index++) {
    const frame = `${run.directory}/frame-${index + 1}.png`;
    await execute("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String((duration * (index + 0.5)) / 4), "-i", mp4, "-frames:v", "1", "-vf", "scale=1000:-1", frame]);
    frames.push(frame);
  }
  const font = contactSheetFont(await execute("magick", ["-list", "font"]));
  await execute("magick", ["montage", "-font", font, ...frames, "-tile", "2x2", "-geometry", "+16+16", `${run.directory}/contact-sheet.png`]);
  await save(`${run.directory}/ffprobe.json`, probe);
  const result = {
    wallSeconds,
    durationSeconds: duration,
    bytes: bytes.length,
    video: probe.streams.filter((stream) => stream.codec_type === "video").map(({ codec_name, width, height, avg_frame_rate }) => ({ codec: codec_name, width, height, frameRate: avg_frame_rate })),
    audio: true,
    contactSheet: `${run.directory}/contact-sheet.png`,
  };
  await save(`${run.directory}/export-proof.json`, result);
  return result;
}
export async function transcriptProof(run, receiver) {
  const started = Date.now();
  await waitFor(
    "Transcript audio preparation",
    async () => {
      const state = await run.apiRequest("GET", `${run.tenantPath}/recordings/${run.recordingId}`);
      await save(`${run.directory}/transcription-preparation.json`, state);
      const status = state.transcription_preparation.status;
      check(!["failed", "expired", "none"].includes(status), `Transcript audio preparation ${status}`);
      return status === "ready";
    },
    240_000,
    5000,
    run.signal,
  );
  const result = await run.apiRequest("POST", `${run.tenantPath}/recordings/${run.recordingId}/transcripts`, { idempotency_key: randomUUID(), language: "en" });
  const transcript = result.transcript;
  console.log("Transcript requested");
  await waitFor(
    "Transcript completion",
    async () => {
      const state = await run.apiRequest("GET", `${run.tenantPath}/transcripts/${transcript.id}`);
      await save(`${run.directory}/transcript-state.json`, state);
      check(!["failed", "deleted", "expired"].includes(state.status), `Transcript ${state.status}`);
      return state.status === "complete";
    },
    240_000,
    5000,
    run.signal,
  );
  const document = await run.apiRequest("GET", `${run.tenantPath}/transcripts/${transcript.id}/document`);
  await save(`${run.directory}/transcript-document.json`, document);
  const text = document.cues
    .map((cue) => cue.text)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ");
  const phrases = ["purple lantern", "quiet river", "screen sharing", "transcription"];
  for (const phrase of phrases) check(text.includes(phrase), `Spoken words missing from Transcript: ${phrase}`);
  const events = await proveWebhookEvents(receiver, [{ event: "transcript.completed", objectId: transcript.id }], run.signal);
  await save(`${run.directory}/signed-webhooks.json`, events);
  return { wallSeconds: (Date.now() - started) / 1000, phrases, transcriptId: transcript.id, signedEvents: events.map((event) => event.event) };
}
export async function smokeProof(run, receiver) {
  const events = await proveWebhookEvents(receiver, [
    { event: "episode.started", objectId: run.episodeId },
    { event: "episode.ended", objectId: run.episodeId },
    { event: "recording.started", objectId: run.recordingId },
    { event: "recording.completed", objectId: run.recordingId },
  ]);
  await save(`${run.directory}/signed-webhooks.json`, events);
  return { apiKey: true, space: true, episode: true, recording: true, mp4Download: true, signedEvents: events.map((event) => event.event) };
}
