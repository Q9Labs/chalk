import { checkCaptureSlotFree, readCapturePool, waitForCapture } from "./capture-pool.mjs";
import { playCall } from "./call-play.mjs";
import { guestCount, judgeScript } from "./call-script.mjs";
import { generateTurnVoices } from "./fixture.mjs";
import { launchGuests } from "./media.mjs";
import { availableSource, createEpisode, createSpace } from "./proofs.mjs";
import { recordingEvidence, recordingFailures, recordingSignals } from "./recording-evidence.mjs";
import { recorderTracks } from "./recorder-tracks.mjs";
import { trackVerdicts } from "./track-verdicts.mjs";
import { measured, mediaPlane, save, waitFor } from "./runtime.mjs";

const automatic = { recording: "automatic", transcription: "automatic" };
/** CHALK_PROOF_TRANSCRIBE=false records the call without paying for a Transcript: the Space asks for one on demand only, and the Transcript check is skipped. */
export function transcribes(env = process.env) {
  return env.CHALK_PROOF_TRANSCRIBE !== "false";
}
/**
 * Runs `create` with the reused Space's Transcript asked for on demand only. An Episode keeps the policies it was created with,
 * so the automatic policy goes back right after. It uses the owner client: it has no abort signal, so a cancelled run still restores the policy.
 */
export async function withTranscriptionOnDemand(run, space, create) {
  const set = (transcription_policy) => run.ownerRequest("PATCH", `${run.tenantPath}/spaces/${space.id}`, { transcription_policy });
  await set("on_demand");
  try {
    return await create();
  } finally {
    await set(automatic.transcription);
  }
}

// Two distinctive words per guest phrase; one match proves that guest's speech reached the Transcript.
const keywords = [
  ["purple lantern", "quiet river"],
  ["copper kettles", "mountain"],
  ["green falcon", "silver harbor"],
];

/** Whether the automatic Capture is recording; a failed one throws with the failure code the SDK reports. */
export function captureReady(current) {
  if (!current) return false;
  measured(current.status !== "failed", `Capture failed before readiness: ${current.failureCode ?? "no failure code"}`);
  return current.status === "recording";
}

/** The public API shows no bundle objects; a Recording source is "available" only once its Capture completed, so these fields stand for the sealed bundles and manifest. */
export function bundleFailures(recording) {
  const failures = [];
  if (recording.source.status !== "available") failures.push(`Recording source is ${recording.source.status}, not available`);
  if (recording.source.stop_reason) failures.push(`Recording source stopped early: ${recording.source.stop_reason}`);
  if (recording.storage_provider !== "r2" || !recording.storage_key) failures.push("Recording has no encrypted storage object");
  if (recording.export.status !== "ready") failures.push(`Recording export is ${recording.export.status}, not ready`);
  return failures;
}

// Three headless Chromium guests play the script in call-script.mjs (turns with markers, a mute, a screen share, an optional capture-node restart, a host stop).
// The Space's automatic policies must start the Recording and the Transcript without any request other than the host's stop.
export async function captureCall(run, receiver) {
  await checkCaptureSlotFree(run);
  const space = await createSpace(run, mediaPlane, automatic);
  const policy = transcribes() ? automatic : { ...automatic, transcription: "on_demand" };
  const { episode, end, useSDK } = transcribes() ? await createEpisode(run, space, policy) : await withTranscriptionOnDemand(run, space, () => createEpisode(run, space, policy));
  run.episodeId = episode.id;
  console.log(`Joining ${guestCount} synthetic camera/voice guests on ${mediaPlane}`);
  const { voices, phraseSeconds } = await generateTurnVoices(run.directory, run.signal);
  const guests = await launchGuests(run, space, episode, voices, receiver.origin, false, guestCount);
  useSDK(guests.pages[0]);
  const others = (guestCount - 1) * 2;
  await waitFor("every guest receives the other guests' camera and microphone", async () =>
    (await Promise.all(guests.pages.map((page) => page.evaluate(() => window.proofClient.getSnapshot().media.remote.filter((entry) => entry.source === "camera" || entry.source === "microphone").length)))).every((count) => count === others),
  );
  await waitForCapture({
    recordingId: () => run.recordingId,
    ready: async () => {
      const current = await guests.pages[0].evaluate(() => window.proofClient.getSnapshot().recording.current);
      if (current) run.recordingId = current.recordingId;
      return captureReady(current);
    },
    readPool: () => readCapturePool(run),
    signal: run.signal,
  });
  console.log("All guests connected and Capture ready; playing the scripted call");
  const script = await playCall(run, guests, phraseSeconds, process.env.CHALK_PROOF_CAPTURE_RESTART_COMMAND);
  await save(`${run.directory}/call-script.json`, script);
  console.log("Ending own Episode");
  await end();
  for (const page of guests.pages) await page.context().close();
  const listed = await waitFor(
    "automatic Recording",
    async () => {
      const value = await run.apiRequest("GET", `${run.tenantPath}/recordings?episode_id=${episode.id}`);
      return value.recordings[0] ?? false;
    },
    300_000,
    5000,
    run.signal,
  );
  run.recordingId = listed.id;
  const recording = await availableSource(run);
  const wanted = transcribes() ? "automatic" : "on_demand";
  measured(recording.transcription_policy === wanted, `Recording effective transcription policy is not ${wanted}`);
  return { script, recordingId: run.recordingId, participants: guests.participants };
}

async function transcriptText(run, transcriptId) {
  const response = await fetch(new URL(`${run.tenantPath}/transcripts/${transcriptId}/text`, run.config.api_url), {
    headers: { Authorization: `Bearer ${run.apiKey}`, Origin: run.config.web_url, "User-Agent": "Chalk-Production-Proof/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  measured(response.ok, `Transcript text download failed: HTTP ${response.status}`);
  return response.text();
}

// The text starts with a title block; the lines after the first blank line are "[hh:mm:ss] Speaker: words".
export function transcriptEvidence(text) {
  const body = text.split("\n\n").slice(1).join("\n\n").trim();
  const spoken = body === "No speech was transcribed." ? "" : body;
  const lines = [...spoken.matchAll(/^\[\d\d:\d\d:\d\d\] (.+?): (.*)$/gm)].map((match) => ({ speaker: match[1], text: match[2] }));
  const normalized = spoken
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ");
  return {
    excerpt: spoken.slice(0, 300),
    wordCount: lines.flatMap((line) => line.text.split(/\s+/)).filter(Boolean).length,
    speakers: [...new Set(lines.map((line) => line.speaker))],
    guests: keywords.map((words, index) => ({ guest: index + 1, heard: words.filter((word) => normalized.includes(word)) })),
  };
}

export function checkTranscript(evidence) {
  measured(evidence.wordCount > 0, "Transcript is empty");
  const silent = evidence.guests.filter((guest) => guest.heard.length === 0).map((guest) => guest.guest);
  measured(!silent.length, `Spoken words missing from Transcript for guest ${silent.join(", ")}`);
}

async function automaticTranscript(run) {
  const transcript = await waitFor(
    "automatic Transcript",
    async () => {
      const value = await run.apiRequest("GET", `${run.tenantPath}/transcripts?recording_id=${run.recordingId}`);
      const current = value.transcripts.find((entry) => entry.status !== "deleted");
      if (!current) return false;
      await save(`${run.directory}/transcript-state.json`, current);
      measured(!["failed", "terminal_failure", "expired"].includes(current.status), `Transcript ${current.status}`);
      return ["complete", "completed"].includes(current.status) ? current : false;
    },
    600_000,
    5000,
    run.signal,
  );
  const text = await transcriptText(run, transcript.id);
  const evidence = transcriptEvidence(text);
  await save(`${run.directory}/transcript-evidence.json`, evidence);
  console.log(`Transcript ${transcript.id}: ${evidence.wordCount} words; excerpt: ${evidence.excerpt}`);
  checkTranscript(evidence);
  return { transcriptId: transcript.id, ...evidence };
}

// The Recording is the MP4 that the export proof downloaded to export.mp4.
export async function callArtifactsProof(run, captured) {
  const { script } = captured;
  const checkedRecording = async () => {
    const file = `${run.directory}/export.mp4`;
    const evidence = await recordingEvidence(file, guestCount);
    await save(`${run.directory}/recording-evidence.json`, evidence);
    const { video, audio, durationSeconds, bytes, guests } = evidence;
    console.log(
      `Recording: ${durationSeconds.toFixed(1)}s, ${bytes} bytes, ${video?.decodedFrames ?? 0} decoded frames, audio mean ${audio?.meanDb ?? "none"} dB, guests on camera: ${guests.filter(({ tile }) => tile?.liveFrames > 0).length}/${guestCount}, live tile frames per guest: ${guests.map(({ tile }) => (tile ? `${tile.liveFrames}/${tile.intervals}` : "none")).join(" ")}`,
    );
    const signals = await recordingSignals(file);
    const judged = judgeScript(script, signals, durationSeconds);
    const tracks = await recorderTracks(run, run.recordingId, captured.participants);
    const verdicts = tracks ? trackVerdicts(script, signals, tracks) : [];
    if (tracks) for (const verdict of verdicts) console.log(`Verdict: ${verdict.text}`);
    else console.log("Per-track check skipped: CHALK_PROOF_RECORDER_TRACKS_COMMAND is not set, so the mix is judged alone");
    await save(`${run.directory}/script-evidence.json`, { ...judged.measurements, flashes: signals.flashes, silences: signals.silences, tones: signals.tones, failures: judged.failures, verdicts });
    console.log(
      `Script: longest silence ${judged.measurements.longestSilenceMs ?? "unknown"} ms of ${judged.measurements.silenceBoundMs ?? "unknown"} ms allowed; ${judged.measurements.markers?.length ?? 0} markers checked; media ended after mute, unshare, host stop: ${judged.measurements.holds?.map((hold) => `${hold.endedAfterMs} ms`).join(", ") ?? "unknown"}`,
    );
    const span = (script.stop.stopMs - script.rounds[0].guests[0].startMs) / 1000;
    const failures = [...recordingFailures(evidence, span * 0.8), ...judged.failures, ...verdicts.filter((verdict) => !verdict.ok).map((verdict) => verdict.text)];
    const source = await run.apiRequest("GET", `${run.tenantPath}/recordings/${run.recordingId}`);
    await save(`${run.directory}/recording.json`, source);
    failures.push(...bundleFailures(source));
    measured(!failures.length, failures.join("; "));
    return evidence;
  };
  // Run both so one failure never hides the other's evidence.
  const [recording, transcript] = await Promise.allSettled([checkedRecording(), transcribes() ? automaticTranscript(run) : undefined]);
  const failures = [recording, transcript].filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join("; "));
  return { recording: recording.value, transcript: transcript.value };
}
