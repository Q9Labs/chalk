// CDP-based collectors for the Chalk web perf harness.
// Every function takes an attached Playwright CDPSession.

import { createWriteStream } from "node:fs";
import { writeFile } from "node:fs/promises";

export async function enableDomains(cdp) {
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("Profiler.enable");
}

// One sample of page-level counters. Returns null when the page is gone.
export async function samplePage(cdp, page) {
  try {
    const [{ metrics }, memory] = await Promise.all([
      cdp.send("Performance.getMetrics"),
      page.evaluate(() => {
        const m = window.performance?.memory;
        return m
          ? { usedJSHeapSize: m.usedJSHeapSize, totalJSHeapSize: m.totalJSHeapSize, jsHeapSizeLimit: m.jsHeapSizeLimit }
          : null;
      }),
    ]);
    const byName = Object.fromEntries(metrics.map((entry) => [entry.name, entry.value]));
    return {
      t: Date.now(),
      url: page.url(),
      nodes: byName.Nodes,
      listeners: byName.JSEventListeners,
      documents: byName.Documents,
      jsHeapUsed: byName.JSHeapUsedSize,
      jsHeapTotal: byName.JSHeapTotalSize,
      scriptDuration: byName.ScriptDuration,
      taskDuration: byName.TaskDuration,
      layoutCount: byName.LayoutCount,
      recalcStyleCount: byName.RecalcStyleCount,
      layoutDuration: byName.LayoutDuration,
      recalcStyleDuration: byName.RecalcStyleDuration,
      memory,
    };
  } catch {
    return null;
  }
}

export function deltaSample(previous, current) {
  if (!previous || !current) return {};
  const fields = ["layoutCount", "recalcStyleCount", "scriptDuration", "taskDuration"];
  const out = {};
  for (const field of fields) out[`${field}Delta`] = Number(((current[field] ?? 0) - (previous[field] ?? 0)).toFixed(2));
  return out;
}

// Whole-run or windowed sampling CPU profile.
export async function startCpuProfile(cdp, samplingIntervalUs = 5000) {
  await cdp.send("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
  await cdp.send("Profiler.start");
}

export async function stopCpuProfile(cdp, filePath) {
  const { profile } = await cdp.send("Profiler.stop");
  await writeFile(filePath, JSON.stringify(profile));
  return { samples: profile.samples?.length ?? 0, nodes: profile.nodes?.length ?? 0 };
}

// Streamed heap snapshot + lightweight structural summary.
export async function takeHeapSnapshot(cdp, filePath) {
  await cdp.send("HeapProfiler.collectGarbage").catch(() => {});
  const stream = createWriteStream(filePath);
  const done = new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
  const onChunk = ({ chunk }) => stream.write(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  }
  stream.end();
  await done;
  return filePath;
}

// Parse a .heapsnapshot enough to answer: how big, how many objects, and what grew?
export async function summarizeHeapSnapshot(filePath) {
  const { readFile } = await import("node:fs/promises");
  const snapshot = JSON.parse(await readFile(filePath, "utf8"));
  const strings = snapshot.strings;
  const meta = snapshot.snapshot.meta;
  const width = meta.node_fields.length;
  const nameIndex = meta.node_fields.indexOf("name");
  const sizeIndex = meta.node_fields.indexOf("self_size");
  const nodes = snapshot.nodes;
  const byClass = new Map();
  let totalSelf = 0;
  let count = 0;
  for (let offset = 0; offset < nodes.length; offset += width) {
    count += 1;
    const size = nodes[offset + sizeIndex];
    totalSelf += size;
    const rawName = nodes[offset + nameIndex];
    const name = typeof rawName === "number" ? strings[rawName] : String(rawName);
    const bucket = byClass.get(name);
    if (bucket) {
      bucket.count += 1;
      bucket.selfSize += size;
    } else {
      byClass.set(name, { count: 1, selfSize: size });
    }
  }
  const top = [...byClass.entries()]
    .sort((a, b) => b[1].selfSize - a[1].selfSize)
    .slice(0, 30)
    .map(([name, stats]) => ({ name, ...stats }));
  return {
    file: filePath.split("/").pop(),
    nodeCount: count,
    totalSelfSize: totalSelf,
    top,
  };
}

// Windowed trace; resolves with event-name counts plus selected timing sums.
export async function traceWindow(page, durationMs, categories = ["devtools.timeline", "disabled-by-default-devtools.timeline"]) {
  const cdp = await page.context().newCDPSession(page);
  const events = [];
  let complete;
  const completed = new Promise((resolve) => { complete = resolve; });
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...value));
  cdp.on("Tracing.tracingComplete", () => complete());
  await cdp.send("Tracing.start", {
    traceConfig: { recordMode: "recordAsMuchAsPossible", includedCategories: categories },
  });
  await page.waitForTimeout(durationMs);
  await cdp.send("Tracing.end");
  await completed;
  const interesting = ["Paint", "PrePaint", "CompositeLayers", "Layerize", "ImageDecode", "ImageDecodeTask", "UpdateLayoutTree", "Layout", "FunctionCall", "TimerFire", "FireAnimationFrame", "RasterTask", "GPUTask"];
  const counts = {};
  const durations = {};
  for (const event of events) {
    if (!interesting.includes(event.name)) continue;
    counts[event.name] = (counts[event.name] ?? 0) + 1;
    durations[event.name] = (durations[event.name] ?? 0) + (event.dur ?? 0);
  }
  try { await cdp.detach(); } catch { /* already gone */ }
  return { durationMs, eventCount: events.length, counts, durationsMicros: durations };
}
