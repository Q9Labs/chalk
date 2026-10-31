export function median(values) {
  if (values.length === 0 || values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error("Leave timings must be finite, nonnegative, and nonempty");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function validateCapturedMedian(value) {
  if (value === undefined) return;
  if (![Number.isFinite(value), value > 0, value <= 5000].every(Boolean)) throw new Error("Captured baseline median must be positive and at most 5000 ms");
}
function summarize(samples) {
  const values = samples.filter((sample) => sample.confirmed).map((sample) => sample.ms);
  if (!values.length) return { median: null, max: null };
  return { median: median(values), max: Math.max(...values) };
}
function confirmed(sample) {
  return sample.confirmed && !sample.deadlineFallback;
}
function safeRejection(sample) {
  return sample.rejectedWhileLeaving && !sample.peerClosedBeforeAck;
}
function limitFor(value) {
  if (value === null) return null;
  return 2 * value + 500;
}
export function evaluateLeaves(baseline, candidate, capturedMedianMs) {
  validateCapturedMedian(capturedMedianMs);
  const reference = baseline.filter((sample) => sample.scenario === "ordinary");
  const ordinary = candidate.filter((sample) => sample.scenario === "ordinary");
  const rejected = candidate.filter((sample) => sample.scenario === "publications-403");
  const complete = [reference.length, ordinary.length, rejected.length].every((count) => count === 5);
  const allConfirmed = [...reference, ...candidate].every(confirmed);
  const observed403 = rejected.every(safeRejection);
  const before = summarize(reference);
  const after = summarize(candidate);
  const referenceMedianMs = capturedMedianMs ?? before.median;
  const limitMs = limitFor(referenceMedianMs);
  return {
    passed: [complete, allConfirmed, observed403, after.median <= limitMs, after.max <= 5000].every(Boolean),
    complete,
    confirmed: allConfirmed,
    observed403,
    baselineMedianMs: before.median,
    referenceMedianMs,
    baselineMaxMs: before.max,
    candidateMedianMs: after.median,
    candidateMaxMs: after.max,
    limitMs,
    baselineSamples: reference.length,
    candidateSamples: candidate.length,
  };
}
