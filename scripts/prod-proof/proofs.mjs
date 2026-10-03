import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generateVoice } from "./fixture.mjs";
import { launchGuests, stats, limitCamera, restoreCamera, proveLayers } from "./media.mjs";
import { check, command, request, recentAuth, save, waitFor } from "./runtime.mjs";
import { proofServer, exposeWebhook, proveWebhookEvents } from "./webhooks.mjs";

export async function prepareIntegration(run, webhooks) {
  const auth = await recentAuth(run.config, run.owner, "api_key.create", run.config.tenant_id);
  const key = await run.ownerRequest(
    "POST",
    `${run.tenantPath}/api-keys`,
    {
      name: "Production proof",
      scopes: ["spaces:read", "spaces:write", "episodes:read", "episodes:write", "recordings:read", "recordings:write", "transcriptions:read", "transcriptions:write"],
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    },
    auth,
  );
  run.apiKey = key.secret;
  run.apiRequest = (method, path, body) => request(run.config, method, path, body, { Authorization: `Bearer ${run.apiKey}` }, {}, run.signal);
  run.resources.push({
    kind: "api-key",
    dispose: async () => {
      const proof = await recentAuth(run.config, run.owner, "api_key.revoke", key.api_key.id);
      await run.ownerRequest("DELETE", `${run.tenantPath}/api-keys/${key.api_key.id}`, undefined, proof);
      const response = await fetch(new URL(`${run.tenantPath}/spaces`, run.config.api_url), { headers: { Authorization: `Bearer ${run.apiKey}` }, signal: AbortSignal.timeout(30_000) });
      check(response.status === 401, "Revoked proof key was still accepted");
    },
  });
  const receiver = await proofServer(run);
  if (webhooks) await exposeWebhook(run, receiver);
  return receiver;
}
async function createSpace(run) {
  const space = await run.apiRequest("POST", `${run.tenantPath}/spaces`, {
    name: "Production proof",
    slug: `prod-proof-${randomUUID()}`,
    media_plane: "cf_sfu",
    recording_policy: "manual",
    transcription_policy: "on_demand",
    default_episode_duration_seconds: 1800,
    maximum_episode_duration_seconds: 1800,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
  });
  run.resources.push({
    kind: "space",
    dispose: async () => {
      const archived = await run.ownerRequest("POST", `${run.tenantPath}/spaces/${space.id}/archive`, {});
      check(archived.archived, "Proof Space was not archived");
    },
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
  const episode = await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, {});
  const ending = episodeEnd(run, `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`);
  run.resources.push({ kind: "episode", dispose: ending.end });
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
    900_000,
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
    900_000,
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
export async function recordProof(run, receiver, cameraShare, forceLayerSwitch) {
  const space = await createSpace(run);
  const { episode, end, useSDK } = await createEpisode(run, space);
  run.episodeId = episode.id;
  console.log("Joining two synthetic camera/voice guests");
  const pages = await launchGuests(run, space, episode, await generateVoice(run.directory, run.signal), receiver.origin);
  useSDK(pages[0]);
  await startCapture(run, pages);
  const sample = statsSampler(run, pages);
  const baselineError = await baselineLayers(run, sample);
  let share = { seconds: 0 };
  if (cameraShare) share = await cameraShareWindow(run, pages, sample, receiver.origin, forceLayerSwitch);
  else await run.wait(5000);
  // End the active Episode once; its lifecycle stops Capture and finalizes the Recording.
  console.log("Ending own Episode and its active Recording");
  await end();
  const recording = await finalizedSource(run);
  for (const page of pages) await page.context().close();
  return { recording, camera: cameraResult(share, baselineError, forceLayerSwitch) };
}
export function contactSheetFont(fonts, platform = process.platform) {
  // macOS ImageMagick can have no registered fonts despite system fonts existing.
  if (platform === "darwin" && !fonts.trim()) return "/System/Library/Fonts/Supplemental/Arial.ttf";
  const font = fonts.match(/^\s*Font:\s*(\S.*)$/m)?.[1].trim();
  check(font, "ImageMagick has no installed font for the contact sheet");
  return font;
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
    1200_000,
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
export async function transcriptProof(run) {
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
    1200_000,
    5000,
    run.signal,
  );
  const result = await run.apiRequest("POST", `${run.tenantPath}/recordings/${run.recordingId}/transcripts`, { idempotency_key: randomUUID(), language: "en" });
  const transcript = result.transcript;
  run.resources.push({ kind: "transcript", dispose: () => run.ownerRequest("DELETE", `${run.tenantPath}/transcripts/${transcript.id}`) });
  console.log("Transcript requested");
  await waitFor(
    "Transcript completion",
    async () => {
      const state = await run.apiRequest("GET", `${run.tenantPath}/transcripts/${transcript.id}`);
      await save(`${run.directory}/transcript-state.json`, state);
      check(!["failed", "deleted", "expired"].includes(state.status), `Transcript ${state.status}`);
      return state.status === "complete";
    },
    1200_000,
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
  return { wallSeconds: (Date.now() - started) / 1000, phrases, transcriptId: transcript.id };
}
function resetMessage(value, address) {
  const body = `${value.subject} ${value.text} ${(value.html ?? []).join(" ")}`;
  return [/reset/i.test(value.subject), /https:\/\//i.test(body), value.to.some((recipient) => recipient.address === address)].every(Boolean);
}
export async function resetProof(run) {
  const config = run.config;
  const tokenResponse = await fetch(new URL("/token", config.inbox_url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: config.username, password: config.inbox_password }), signal: AbortSignal.timeout(30_000) });
  check(tokenResponse.ok, `Inbox login failed: HTTP ${tokenResponse.status}`);
  const { token } = await tokenResponse.json();
  const inbox = async (path) => {
    const response = await fetch(new URL(path, config.inbox_url), { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    check(response.ok, `Inbox read failed: HTTP ${response.status}`);
    return response.json();
  };
  const existing = new Set((await inbox("/messages"))["hydra:member"].map((message) => message.id));
  const started = Date.now();
  await request(config, "POST", "/v1/auth/password-reset/request", { email: config.username });
  const message = await waitFor(
    "password-reset email",
    async () => {
      const messages = (await inbox("/messages"))["hydra:member"];
      for (const entry of messages) {
        if (existing.has(entry.id)) continue;
        const value = await inbox(`/messages/${entry.id}`);
        if (resetMessage(value, config.username)) return value;
      }
      return false;
    },
    120_000,
    3000,
    run.signal,
  );
  await save(`${run.directory}/reset-email.json`, { received: true, elapsedSeconds: (Date.now() - started) / 1000, subject: message.subject });
  // Arrival proof only: never consume the reset token or rotate the permanent owner's password.
  return { received: true, wallSeconds: (Date.now() - started) / 1000, passwordUnchanged: true };
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
