// Pass and fail rules for the M7 canary check, apart from the browser run that feeds them.
export function percentile(values, fraction) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

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

// Within one connection, a stream moves when its counters grew between two samples.
export function grew(rows, previous, kind, source) {
  return rows.some((row) => {
    if (row.type !== "inbound-rtp" || row.kind !== kind || row.source !== source) return false;
    const before = previous.find((candidate) => candidate.id === row.id && candidate.connection === row.connection);
    if (!before || !(row.bytesReceived > before.bytesReceived)) return false;
    return kind !== "video" || row.framesDecoded > before.framesDecoded;
  });
}

export function rendering(after, before) {
  return after.length === 2 && after.every((rows, guest) => grew(rows, before[guest], "video", "camera") && grew(rows, before[guest], "audio", "microphone"));
}

// A fault interrupted the call when each client's camera video was measured on the same
// stream twice and did not move. A stream that appeared or changed between samples proves nothing.
export function stalled(after, before) {
  return (
    after.length === 2 &&
    after.every((rows, guest) => {
      const measured = rows.filter((row) => row.type === "inbound-rtp" && row.kind === "video" && row.source === "camera" && before[guest].some((candidate) => candidate.id === row.id && candidate.connection === row.connection));
      return measured.length > 0 && !grew(rows, before[guest], "video", "camera");
    })
  );
}
