import { checkCaptureSlotFree, readCapturePool, waitForCapture } from "./capture-pool.mjs";
import { generateTurnVoices, turnPhrases } from "./fixture.mjs";
import { launchGuests } from "./media.mjs";
import { availableSource, createEpisode, createSpace } from "./proofs.mjs";
import { checkRecording, recordingEvidence } from "./recording-evidence.mjs";
import { check, mediaPlane, save, waitFor } from "./runtime.mjs";

const guestCount = turnPhrases.length;
// A looping voice cycle is 36 seconds, so a shorter call can end before every guest has spoken.
const minimumCallSeconds = 40;
const automatic = { recording: "automatic", transcription: "automatic" };
// Two distinctive words per guest phrase; one match proves that guest's speech reached the Transcript.
const keywords = [
  ["purple lantern", "quiet river"],
  ["copper kettles", "mountain"],
  ["green falcon", "silver harbor"],
];

export function callSeconds(environment = process.env) {
  const seconds = Number(environment.CHALK_PROOF_CALL_SECONDS ?? 60);
  check(Number.isFinite(seconds) && seconds >= minimumCallSeconds, `CHALK_PROOF_CALL_SECONDS must be at least ${minimumCallSeconds}`, "configuration");
  return seconds;
}

// Three headless Chromium guests each publish a camera and a voice that speaks only in its own slot.
// The Space's automatic policies must start the Recording and the Transcript without any request.
export async function captureCall(run, receiver) {
  const seconds = callSeconds();
  await checkCaptureSlotFree(run);
  const space = await createSpace(run, mediaPlane, automatic);
  const { episode, end, useSDK } = await createEpisode(run, space, automatic);
  run.episodeId = episode.id;
  console.log(`Joining ${guestCount} synthetic camera/voice guests on ${mediaPlane}`);
  const guests = await launchGuests(run, space, episode, await generateTurnVoices(run.directory, run.signal), receiver.origin, false, guestCount);
  useSDK(guests.pages[0]);
  const others = (guestCount - 1) * 2;
  await waitFor("every guest receives the other guests' camera and microphone", async () =>
    (await Promise.all(guests.pages.map((page) => page.evaluate(() => window.proofClient.getSnapshot().media.remote.filter((entry) => entry.source === "camera" || entry.source === "microphone").length)))).every((count) => count === others),
  );
  await waitForCapture({
    recordingId: () => run.recordingId,
    ready: async () => {
      const current = await guests.pages[0].evaluate(() => window.proofClient.getSnapshot().recording.current);
      if (!current) return false;
      check(current.status !== "failed", "Capture failed before readiness");
      run.recordingId = current.recordingId;
      return current.status === "recording";
    },
    readPool: () => readCapturePool(run),
    signal: run.signal,
  });
  console.log(`All guests connected and Capture ready; holding the call for ${seconds}s`);
  await run.wait(seconds * 1000);
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
  check(recording.transcription_policy === "automatic", "Recording effective transcription policy is not automatic");
  return { callSeconds: seconds, recordingId: run.recordingId };
}

async function transcriptText(run, transcriptId) {
  const response = await fetch(new URL(`${run.tenantPath}/transcripts/${transcriptId}/text`, run.config.api_url), {
    headers: { Authorization: `Bearer ${run.apiKey}`, Origin: run.config.web_url, "User-Agent": "Chalk-Production-Proof/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  check(response.ok, `Transcript text download failed: HTTP ${response.status}`);
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
  check(evidence.wordCount > 0, "Transcript is empty");
  const silent = evidence.guests.filter((guest) => guest.heard.length === 0).map((guest) => guest.guest);
  check(!silent.length, `Spoken words missing from Transcript for guest ${silent.join(", ")}`);
}

async function automaticTranscript(run) {
  const transcript = await waitFor(
    "automatic Transcript",
    async () => {
      const value = await run.apiRequest("GET", `${run.tenantPath}/transcripts?recording_id=${run.recordingId}`);
      const current = value.transcripts.find((entry) => entry.status !== "deleted");
      if (!current) return false;
      await save(`${run.directory}/transcript-state.json`, current);
      check(!["failed", "terminal_failure", "expired"].includes(current.status), `Transcript ${current.status}`);
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
  const checkedRecording = async () => {
    const evidence = await recordingEvidence(`${run.directory}/export.mp4`, guestCount);
    await save(`${run.directory}/recording-evidence.json`, evidence);
    const { video, audio, durationSeconds, bytes, guests } = evidence;
    console.log(`Recording: ${durationSeconds.toFixed(1)}s, ${bytes} bytes, ${video?.decodedFrames ?? 0} decoded frames, audio mean ${audio?.meanDb ?? "none"} dB, guests on camera: ${guests.filter(({ camera }) => camera?.visible).length}/${guestCount}`);
    checkRecording(evidence, captured.callSeconds * 0.8);
    return evidence;
  };
  // Run both so one failure never hides the other's evidence.
  const [recording, transcript] = await Promise.allSettled([checkedRecording(), automaticTranscript(run)]);
  const failures = [recording, transcript].filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, failures.map((failure) => failure.message).join("; "));
  return { recording: recording.value, transcript: transcript.value };
}
