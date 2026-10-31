export function median(values) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Leave timings must be finite, nonnegative, and nonempty");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export function evaluateLeaves(baseline, candidate, capturedMedianMs) {
  if (capturedMedianMs !== undefined && (!Number.isFinite(capturedMedianMs) || capturedMedianMs <= 0 || capturedMedianMs > 5000)) throw new Error("Captured baseline median must be positive and at most 5000 ms");
  const reference = baseline.filter((sample) => sample.scenario === "ordinary");
  const ordinary = candidate.filter((sample) => sample.scenario === "ordinary");
  const rejected = candidate.filter((sample) => sample.scenario === "publications-403");
  const complete = reference.length === 5 && ordinary.length === 5 && rejected.length === 5;
  const confirmed = [...reference, ...candidate].every((sample) => sample.confirmed && !sample.deadlineFallback);
  const observed403 = rejected.every((sample) => sample.rejectedWhileLeaving && !sample.peerClosedBeforeAck);
  const baselineMs = reference.filter((sample) => sample.confirmed).map((sample) => sample.ms);
  const candidateMs = candidate.filter((sample) => sample.confirmed).map((sample) => sample.ms);
  const baselineMedianMs = baselineMs.length ? median(baselineMs) : null;
  const candidateMedianMs = candidateMs.length ? median(candidateMs) : null;
  const referenceMedianMs = capturedMedianMs ?? baselineMedianMs;
  const limitMs = referenceMedianMs === null ? null : 2 * referenceMedianMs + 500;
  const candidateMaxMs = candidateMs.length ? Math.max(...candidateMs) : null;
  return {
    passed: complete && confirmed && observed403 && candidateMedianMs <= limitMs && candidateMaxMs <= 5000,
    complete,
    confirmed,
    observed403,
    baselineMedianMs,
    referenceMedianMs,
    baselineMaxMs: baselineMs.length ? Math.max(...baselineMs) : null,
    candidateMedianMs,
    candidateMaxMs,
    limitMs,
    baselineSamples: reference.length,
    candidateSamples: candidate.length,
  };
}
