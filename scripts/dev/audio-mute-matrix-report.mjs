import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const directory = resolve(process.argv[2] || "artifacts/th-audio-1030-evening");
const report = JSON.parse(await readFile(`${directory}/matrix.json`, "utf8"));
const summaries = report.versions.map((run) => {
  const previous = new Map();
  const pairs = Array.from({ length: 4 }, (_, listener) => Array.from({ length: 4 }, (_, speaker) => ({ listener, speaker, lostSeconds: 0, expectedSeconds: 0, audibleSeconds: 0 })))
    .flat()
    .filter((pair) => pair.listener !== pair.speaker);
  const audibleSamples = [];
  let lastT = 0;
  let lastAudible = new Set();
  const expectedSeconds = (speaker, from, to) => {
    let enabled = true;
    let cursor = from;
    let seconds = 0;
    for (const action of run.actions.filter((action) => ["mic", "moderator"].includes(action.kind) && action.participant === speaker)) {
      if (action.t <= from) enabled = action.enabled;
      else if (action.t < to) {
        if (enabled) seconds += action.t - cursor;
        cursor = action.t;
        enabled = action.enabled;
      }
    }
    return seconds + (enabled ? to - cursor : 0);
  };
  for (const sample of run.samples) {
    const audible = new Set();
    for (const state of sample.states)
      for (const track of state.tracks) {
        const key = `${state.listener}:${track.speaker}:${track.track}`;
        const before = previous.get(key);
        const rising = before ? track.packets > before.packets : track.packets > 0;
        if (rising && track.audioLevel > 0 && track.readyState === "live" && !track.muted) audible.add(`${state.listener}:${track.speaker}`);
        previous.set(key, track);
      }
    audibleSamples.push({ t: sample.t, audible });
    // Exclude initial subscription warmup; include recovery and action latency.
    if (sample.t > 10)
      for (const pair of pairs) {
        const exposure = expectedSeconds(pair.speaker, Math.max(10, lastT), sample.t);
        pair.expectedSeconds += exposure;
        if (lastAudible.has(`${pair.listener}:${pair.speaker}`)) pair.audibleSeconds += exposure;
        else pair.lostSeconds += exposure;
      }
    lastT = sample.t;
    lastAudible = audible;
  }
  const unmutes = [];
  for (const action of run.actions.filter((action) => action.kind === "mic" && action.enabled)) {
    const nextMute = run.actions.find((other) => other.t > action.t && ["mic", "moderator"].includes(other.kind) && other.participant === action.participant && !other.enabled);
    const deadline = nextMute?.t ?? lastT;
    for (let listener = 0; listener < 4; listener++)
      if (listener !== action.participant) {
        const first = audibleSamples.find((sample) => sample.t >= action.t && (nextMute ? sample.t < deadline : sample.t <= deadline) && sample.audible.has(`${listener}:${action.participant}`));
        unmutes.push({ listener, speaker: action.participant, actionT: action.t, seconds: first ? first.t - action.t : null, pending: !first && !nextMute && !run.completed, observationSeconds: deadline - action.t, actionError: action.error ?? null });
      }
  }
  const latencies = unmutes.flatMap((unmute) => (unmute.seconds === null ? [] : [unmute.seconds])).sort((a, b) => a - b);
  const median = latencies.length ? (latencies.length % 2 ? latencies[(latencies.length - 1) / 2] : (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2) : null;
  const statusCounts = {};
  for (const event of run.network) {
    const operation = event.path.endsWith("/tracks") ? (event.operation?.includes("local") ? "publish" : "pull") : event.path.endsWith("/close") ? "close" : "other";
    const key = `${operation}:${event.status}`;
    statusCounts[key] = (statusCounts[key] || 0) + 1;
  }
  const providerStatusCounts = {};
  for (const failure of run.providerFailures ?? []) {
    const operation = failure.operation === "add_tracks" ? (Number(failure.request_local_track_count) > 0 ? "publish" : "pull") : failure.operation;
    const key = `${operation}:${failure.http_status}`;
    providerStatusCounts[key] = (providerStatusCounts[key] || 0) + 1;
  }
  return {
    version: run.version,
    sdkRevision: run.sdkRevision,
    completed: run.completed ?? null,
    sessionsPerParticipant: run.sessionsPerParticipant ?? [],
    measuredSeconds: lastT,
    apiStatusCounts: statusCounts,
    providerStatusCounts,
    pairs,
    lostPairSeconds: pairs.reduce((sum, pair) => sum + pair.lostSeconds, 0),
    medianUnmuteSeconds: median,
    maxUnmuteSeconds: latencies.at(-1) ?? null,
    neverAudible: unmutes.filter((unmute) => unmute.seconds === null && !unmute.pending).length,
    pendingUnmuteObservations: unmutes.filter((unmute) => unmute.pending).length,
    unmuteListenerObservations: unmutes.length,
    unmutes,
    actionErrors: run.actions.filter((action) => action.error),
    faults: run.faults,
    sampleErrors: run.samples.flatMap((sample) => sample.states.filter((state) => state.error).map((state) => ({ t: sample.t, listener: state.listener, error: state.error }))),
    initialAudiblePairs: audibleSamples.filter((sample) => sample.t >= 10 && sample.t < 20).map((sample) => sample.audible.size),
    finalAudiblePairs: audibleSamples.slice(-5).map((sample) => sample.audible.size),
  };
});
await writeFile(`${directory}/summary.json`, JSON.stringify(summaries, null, 2));
console.log(
  JSON.stringify(
    summaries.map(({ pairs, unmutes, ...summary }) => summary),
    null,
    2,
  ),
);
