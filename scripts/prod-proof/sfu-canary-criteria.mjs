// Pass and fail rules for the M7 canary check, apart from the browser run that feeds them.
import { percentile } from "../../features/scorecard/stats.mjs";

export function summarize(trials, limitMs) {
  const times = trials.filter((trial) => trial.ms !== undefined).map((trial) => trial.ms);
  return {
    trials: trials.length,
    withinLimit: trials.filter((trial) => trial.ms !== undefined && trial.ms <= limitMs).length,
    failed: trials.filter((trial) => trial.error).length,
    p50Ms: percentile(times, 0.5),
    p95Ms: percentile(times, 0.95),
    maxMs: times.length ? Math.max(...times) : null,
  };
}

const isStream = (row, kind, source) => row.type === "inbound-rtp" && row.kind === kind && row.source === source;
const sameStream = (row) => (candidate) => candidate.id === row.id && candidate.connection === row.connection;

function advanced(row, before) {
  if (!(row.bytesReceived > before.bytesReceived)) return false;
  return row.kind !== "video" || row.framesDecoded > before.framesDecoded;
}

// Within one connection, a stream moves when its counters grew between two samples. growing counts such streams.
export function growing(rows, previous, kind, source) {
  return rows.filter((row) => {
    if (!isStream(row, kind, source)) return false;
    const before = previous.find(sameStream(row));
    return before !== undefined && advanced(row, before);
  }).length;
}

export function grew(rows, previous, kind, source) {
  return growing(rows, previous, kind, source) > 0;
}

export function rendering(after, before) {
  return after.length === 2 && after.every((rows, guest) => grew(rows, before[guest], "video", "camera") && grew(rows, before[guest], "audio", "microphone"));
}

const measuredCamera = (rows, before) => rows.filter((row) => isStream(row, "video", "camera") && before.some(sameStream(row)));

// A fault interrupted the call when each client's camera video was measured on the same
// stream twice and did not move. A stream that appeared or changed between samples proves nothing.
export function stalled(after, before) {
  return after.length === 2 && after.every((rows, guest) => measuredCamera(rows, before[guest]).length > 0 && !grew(rows, before[guest], "video", "camera"));
}

// What each client's camera and connections did across a stall check, so a failed check names the cause.
export function stallEvidence(after, before) {
  return after.map((rows, guest) => ({
    connections: rows.filter((row) => row.type === "peer-state").map((row) => `${row.connection}:${row.connectionState}/${row.iceConnectionState}`),
    camera: rows
      .filter((row) => isStream(row, "video", "camera"))
      .map((row) => {
        const previous = before[guest].find(sameStream(row));
        return { connection: row.connection, id: row.id, bytes: previous ? row.bytesReceived - previous.bytesReceived : "new", frames: previous ? row.framesDecoded - previous.framesDecoded : "new" };
      }),
  }));
}
