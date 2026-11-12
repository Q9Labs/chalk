import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { summarizeHeap } from "./call-heap-summary.mjs";

/** What a leak run reads from a page, and the growth arithmetic that turns readings into failures. */

export function growth(values) {
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) throw new Error("Growth requires at least two finite samples");
  const center = (values.length - 1) / 2;
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  let numerator = 0;
  let denominator = 0;
  values.forEach((value, index) => {
    numerator += (index - center) * (value - average);
    denominator += (index - center) ** 2;
  });
  return numerator / denominator;
}

export function leakFailures(samples, budgets, { left = false } = {}) {
  return Object.entries(budgets.metrics).flatMap(([metric, limit]) => {
    const values = samples.map((sample) => sample[metric]);
    if (values.some((value) => !Number.isFinite(value))) throw new Error(`Missing leak measurement ${metric}`);
    const slope = growth(values);
    const excess = Math.max(...values.slice(1)) - values[0];
    return [
      ...(limit.tailPerCycle !== undefined && values.length >= 11 && growth(values.slice(-10)) > limit.tailPerCycle ? [`${metric}: late slope ${growth(values.slice(-10)).toFixed(4)} > ${limit.tailPerCycle}/cycle`] : []),
      ...(slope > limit.perCycle ? [`${metric}: slope ${slope.toFixed(4)} > ${limit.perCycle}/cycle`] : []),
      ...(excess > limit.allowance ? [`${metric}: baseline excess ${excess.toFixed(4)} > ${limit.allowance}`] : []),
      ...(left && ["liveTracks", "audioContexts"].includes(metric) && values.some((value) => value !== 0) ? [`${metric}: full leave must be zero`] : []),
    ];
  });
}

export async function sample(page, cdp, settleMs) {
  await page.waitForTimeout(settleMs);
  await waitForToastTeardown(page);
  let previous;
  for (let attempt = 0; attempt < 6; attempt++) {
    await cdp.send("HeapProfiler.collectGarbage");
    await page.waitForTimeout(200);
    await cdp.send("HeapProfiler.collectGarbage");
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const counters = await cdp.send("Memory.getDOMCounters");
    const current = { heapMiB: metrics.JSHeapUsedSize / 1024 ** 2, domNodes: counters.nodes, listeners: counters.jsEventListeners, documents: counters.documents, ...(await page.evaluate(() => window.__callLeaks())) };
    // Do not choose a minimum: require consecutive stable resource counts, then
    // retain that actual reading. A continuing leak cannot be collected away.
    if (
      previous &&
      Object.keys(current)
        .filter((metric) => !["heapMiB", "animationFrames"].includes(metric))
        .every((metric) => current[metric] === previous[metric])
    )
      return current;
    previous = current;
  }
  throw new Error(`Resource teardown did not stabilize: ${JSON.stringify(previous)}`);
}

export async function waitForToastTeardown(page) {
  try {
    // Info toasts last 5 seconds, followed by a 160 ms exit animation.
    await page.waitForFunction(() => !document.querySelector('[data-part="toast-stack"] [data-part="toast"]'), undefined, { timeout: 6000 });
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    throw new Error("Call toasts did not expire within 6000 ms; refusing to sample retained DOM", { cause: error });
  }
}

export async function snapshot(cdp, directory, id) {
  await mkdir(directory, { recursive: true });
  const chunks = [];
  const receive = ({ chunk }) => chunks.push(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", receive);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: true });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", receive);
  }
  const path = resolve(directory, `${id}.heapsnapshot`);
  const serialized = chunks.join("");
  await writeFile(path, serialized);
  const summary = summarizeHeap(JSON.parse(serialized));
  console.log(`Leak snapshot ${path}: detached DOM nodes=${summary.detachedNodes}; largest retained object types=${JSON.stringify(summary.largestRetainedTypes)}`);
  return { path, ...summary };
}
