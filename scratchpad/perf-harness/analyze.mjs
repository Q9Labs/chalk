// Summarizes a harness run directory into the numbers used by the report.
//
//   node analyze.mjs <runDir>
//
// Prints: heap growth between snapshot beats, DOM/listener/heap trends from
// metrics.ndjson, per-trace paint/compositing rates, and CPU profile hotspots.

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const runDir = process.argv[2];
if (!runDir) {
  console.error("usage: node analyze.mjs <runDir>");
  process.exit(2);
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)}MB`;
}

async function snapshots() {
  const entries = await readdir(runDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".summary.json")).map((entry) => ({ name: entry.name, path: join(runDir, entry.name) }));
  const withTimes = await Promise.all(files.map(async (file) => ({ ...file, mtime: (await import("node:fs/promises")).stat(file.path).then((stats) => stats.mtimeMs) })));
  withTimes.sort((a, b) => a.mtime - b.mtime);
  const rows = [];
  for (const file of withTimes) {
    const summary = JSON.parse(await readFile(file.path, "utf8"));
    rows.push({ tag: summary.tag ?? file.name, nodes: summary.nodeCount, self: summary.totalSelfSize });
  }
  return rows;
}

async function metrics() {
  const lines = (await readFile(join(runDir, "metrics.ndjson"), "utf8")).trim().split("\n");
  const rows = lines.map((line) => JSON.parse(line));
  const byPerson = new Map();
  for (const row of rows) {
    if (!byPerson.has(row.person)) byPerson.set(row.person, []);
    byPerson.get(row.person).push(row);
  }
  const trends = {};
  for (const [person, samples] of byPerson) {
    if (samples.length < 4) continue;
    const first = samples.slice(0, 5);
    const last = samples.slice(-5);
    const avg = (array, key) => array.reduce((sum, row) => sum + (row[key] ?? 0), 0) / array.length;
    const deltas = {};
    for (const field of ["scriptDurationDelta", "taskDurationDelta", "layoutCountDelta", "recalcStyleCountDelta"]) {
      deltas[field] = Number(samples.reduce((sum, row) => sum + (row[field] ?? 0), 0).toFixed(1));
    }
    trends[person] = {
      samples: samples.length,
      nodesFirst: Math.round(avg(first, "nodes")),
      nodesLast: Math.round(avg(last, "nodes")),
      listenersFirst: Math.round(avg(first, "listeners")),
      listenersLast: Math.round(avg(last, "listeners")),
      jsHeapFirstMB: Number((avg(first, "jsHeapUsed") / 1e6).toFixed(1)),
      jsHeapLastMB: Number((avg(last, "jsHeapUsed") / 1e6).toFixed(1)),
      documentsLast: Math.round(avg(last, "documents")),
      ...deltas,
    };
  }
  return trends;
}

async function traces() {
  try {
    const dir = join(runDir, "traces");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    const out = [];
    for (const file of files) {
      const trace = JSON.parse(await readFile(join(dir, file), "utf8"));
      const seconds = trace.durationMs / 1000;
      out.push({
        tag: file.replace("trace-", "").replace(".json", ""),
        paintsPerSec: Number(((trace.counts.Paint ?? 0) / seconds).toFixed(1)),
        prePaintsPerSec: Number(((trace.counts.PrePaint ?? 0) / seconds).toFixed(1)),
        layoutsPerSec: Number(((trace.counts.Layout ?? 0) / seconds).toFixed(1)),
        styleRecalcPerSec: Number(((trace.counts.UpdateLayoutTree ?? 0) / seconds).toFixed(1)),
        rasterPerSec: Number(((trace.counts.RasterTask ?? 0) / seconds).toFixed(1)),
        layoutDurMs: Number(((trace.durationsMicros.Layout ?? 0) / 1000).toFixed(0)),
        scriptDurMs: Number(((trace.durationsMicros.FunctionCall ?? 0) / 1000).toFixed(0)),
      });
    }
    return out.sort((a, b) => a.tag.localeCompare(b.tag));
  } catch {
    return [];
  }
}

async function cpuHotspots(file, topN = 12) {
  try {
    const profile = JSON.parse(await readFile(join(runDir, file), "utf8"));
    const selfTime = new Map();
    const idToNode = new Map(profile.nodes.map((node) => [node.id, node]));
    // timeDeltas[i] belongs to samples[i]; attribute to the sampled node itself.
    for (let index = 0; index < profile.samples.length; index += 1) {
      const nodeId = profile.samples[index];
      const delta = profile.timeDeltas[index] ?? 0;
      if (!idToNode.has(nodeId)) continue;
      const node = idToNode.get(nodeId);
      const label = `${node.callFrame.functionName || "(anonymous)"} @ ${(node.callFrame.url || "").split("/").slice(-2).join("/")}:${node.callFrame.lineNumber ?? "?"}`;
      selfTime.set(label, (selfTime.get(label) ?? 0) + delta);
    }
    const total = [...selfTime.values()].reduce((a, b) => a + b, 0) || 1;
    return [...selfTime.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([label, micros]) => ({ label, ms: Number((micros / 1000).toFixed(0)), pct: Number(((micros / total) * 100).toFixed(1)) }));
  } catch (error) {
    return [{ label: `unavailable: ${String(error).slice(0, 80)}`, ms: 0, pct: 0 }];
  }
}

const [snapRows, metricTrends, traceRows] = await Promise.all([snapshots(), metrics(), traces()]);

console.log("=== HEAP SNAPSHOT BEATS ===");
for (const row of snapRows) console.log(`${row.tag.padEnd(28)} nodes=${row.nodes} self=${mb(row.self)}`);

console.log("\n=== SNAPSHOT DELTAS ===");
for (let index = 1; index < snapRows.length; index += 1) {
  const previous = snapRows[index - 1];
  const current = snapRows[index];
  console.log(`${previous.tag} -> ${current.tag}: nodes ${current.nodes - previous.nodes >= 0 ? "+" : ""}${current.nodes - previous.nodes}, self ${current.self - previous.self >= 0 ? "+" : ""}${mb(Math.abs(current.self - previous.self))}`);
}

// Which object classes grew most between the first and last snapshot?
if (snapRows.length >= 2) {
  const dirEntries = (await readdir(runDir)).filter((n) => n.endsWith(".summary.json")).sort();
  const first = JSON.parse(await readFile(join(runDir, dirEntries[0]), "utf8"));
  const last = JSON.parse(await readFile(join(runDir, dirEntries.at(-1)), "utf8"));
  console.log("\n=== TOP CLASS GROWTH (first vs last snapshot, within top-30 sets) ===");
  const growth = [];
  for (const entry of last.top) {
    const before = first.top.find((candidate) => candidate.name === entry.name);
    growth.push({ name: entry.name, delta: entry.selfSize - (before?.selfSize ?? 0), nowSelf: entry.selfSize, nowCount: entry.count });
  }
  for (const entry of growth.sort((a, b) => b.delta - a.delta).slice(0, 10)) {
    console.log(`${entry.name.slice(0, 48).padEnd(50)} +${mb(entry.delta)} (now ${mb(entry.nowSelf)}, count ${entry.nowCount})`);
  }
}

console.log("\n=== METRIC TRENDS PER PARTICIPANT ===");
for (const [person, trend] of Object.entries(metricTrends)) {
  console.log(person, JSON.stringify(trend));
}

console.log("\n=== WINDOWED TRACES (per-second rates during feature windows) ===");
for (const row of traceRows) console.log(JSON.stringify(row));

console.log("\n=== WHOLE-RUN CPU PROFILE HOTSPOTS (P1, self time) ===");
for (const hotspot of await cpuHotspots("cpu-p1.cpuprofile")) {
  console.log(`${String(hotspot.ms).padStart(6)}ms ${String(hotspot.pct).padStart(5)}% ${hotspot.label}`);
}

try {
  const windowFiles = (await readdir(runDir)).filter((name) => name.startsWith("cpu-window-") && name.endsWith(".cpuprofile")).sort();
  if (windowFiles.length) {
    console.log("\n=== WINDOWED CPU PROFILES (P2, 1ms sampling) ===");
    for (const file of windowFiles) {
      console.log(`-- ${file}`);
      for (const hotspot of (await cpuHotspots(file, 8)).filter((hotspot) => hotspot.label !== "(idle)")) {
        console.log(`${String(hotspot.ms).padStart(6)}ms ${String(hotspot.pct).padStart(5)}% ${hotspot.label}`);
      }
    }
  }
} catch {
  /* optional */
}
