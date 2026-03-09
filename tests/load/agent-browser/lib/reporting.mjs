export function buildSummary(records, options, outDir, runLabel) {
  const successes = records.filter((r) => r.status === "success");
  const failures = records.filter((r) => r.status === "failed");
  const joinTimes = successes.map((r) => r.askToJoinToJoinedMs).filter((v) => Number.isFinite(v));
  const createTimes = records.map((r) => r.createToPrejoinMs).filter((v) => Number.isFinite(v));
  const failureReasons = Object.entries(
    failures.reduce((acc, r) => {
      const key = r.failureReason ?? "unknown_failure";
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
  )
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => ({ reason, count }));

  return {
    runLabel,
    startedAt: records.map((r) => r.startedAt).sort()[0] ?? null,
    finishedAt: new Date().toISOString(),
    outDir,
    options,
    attempts: records.length,
    success: successes.length,
    failed: failures.length,
    successRate: percent(successes.length, records.length),
    joinMs: metric(joinTimes),
    createMs: metric(createTimes),
    failureReasons,
  };
}

export function buildMarkdown(summary, records) {
  const slowest = [...records]
    .filter((r) => Number.isFinite(r.askToJoinToJoinedMs))
    .sort((a, b) => b.askToJoinToJoinedMs - a.askToJoinToJoinedMs)
    .slice(0, 10);
  const lines = [
    "# Agent Browser Join Stress Report",
    "",
    `- Run: ${summary.runLabel}`,
    `- Attempts: ${summary.attempts}`,
    `- Success: ${summary.success}`,
    `- Failed: ${summary.failed}`,
    `- Success rate: ${summary.successRate}%`,
    "",
    "## Join Latency (ms)",
    "",
    `- min: ${summary.joinMs.min ?? "-"}`,
    `- p50: ${summary.joinMs.p50 ?? "-"}`,
    `- p95: ${summary.joinMs.p95 ?? "-"}`,
    `- p99: ${summary.joinMs.p99 ?? "-"}`,
    `- max: ${summary.joinMs.max ?? "-"}`,
    `- avg: ${summary.joinMs.avg ?? "-"}`,
    "",
    "## Failure Reasons",
    "",
    ...(summary.failureReasons.length ? summary.failureReasons.map((f) => `- ${f.reason}: ${f.count}`) : ["- none"]),
    "",
    "## Slowest Successful Attempts",
    "",
    ...slowest.map((r) => `- attempt ${r.attempt}: ${r.askToJoinToJoinedMs}ms (${r.roomUrl ?? "n/a"})`),
    "",
  ];
  return lines.join("\n");
}

export function printSummary(summary) {
  console.log("\n[join-stress] complete");
  console.log(`[join-stress] attempts=${summary.attempts} success=${summary.success} failed=${summary.failed} successRate=${summary.successRate}%`);
  console.log(`[join-stress] joinMs min=${summary.joinMs.min ?? "-"} p50=${summary.joinMs.p50 ?? "-"} p95=${summary.joinMs.p95 ?? "-"} p99=${summary.joinMs.p99 ?? "-"} max=${summary.joinMs.max ?? "-"}`);
  if (summary.failureReasons.length) {
    console.log(`[join-stress] topFailure=${summary.failureReasons[0].reason} (${summary.failureReasons[0].count})`);
  }
  console.log(`[join-stress] artifacts=${summary.outDir}`);
}

function metric(values) {
  if (!values.length) return { min: null, p50: null, p95: null, p99: null, max: null, avg: null };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
  return {
    min: sorted[0],
    p50: roundPercentile(sorted, 50),
    p95: roundPercentile(sorted, 95),
    p99: roundPercentile(sorted, 99),
    max: sorted[sorted.length - 1],
    avg,
  };
}

function roundPercentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return Math.round(sorted[low]);
  return Math.round(sorted[low] + (sorted[high] - sorted[low]) * (idx - low));
}

function percent(num, den) {
  if (!den) return 0;
  return Math.round((num / den) * 10000) / 100;
}
