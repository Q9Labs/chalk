import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { summarizeTrace } from "./tracing.mjs";

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function readNdjson(path) {
  try {
    const text = await readFile(path, "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function average(rows, field) {
  const values = rows.map((row) => Number(row[field])).filter(Number.isFinite);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function rounded(value, digits = 3) {
  return value === null || value === undefined ? null : Number(value.toFixed(digits));
}

function isApplicationFrame(url) {
  return !/(?:node_modules|\.pnpm|playwright)/.test(url) && /(?:\/src\/|\/apps\/web\/|\/sdks\/typescript\/|\/packages\/)/.test(url);
}

export function summarizeMetrics(rows) {
  const samples = rows.filter((row) => row.kind === "sample");
  const liveSamples = samples.filter((row) => row.url !== "about:blank");
  const errors = rows.filter((row) => row.kind === "error");
  const drift = rows.filter((row) => row.kind === "drift");
  const hostLoadRows = drift.filter((row) => Number.isFinite(row.hostLoad1m));
  const processRows = rows.filter((row) => row.kind === "process");
  const participants = {};
  const grouped = new Map();
  for (const row of liveSamples) {
    const bucket = grouped.get(row.participant) ?? [];
    bucket.push(row);
    grouped.set(row.participant, bucket);
  }
  for (const [participant, participantRows] of grouped) {
    const first = participantRows[0];
    const last = participantRows.at(-1);
    const bucket = { samples: participantRows.length, first, last, averages: {}, beforeAfter: {}, perMinute: {} };
    for (const field of ["jsHeapUsed", "nodes", "listeners", "documents", "layoutCount", "recalcStyleCount", "scriptDuration", "taskDuration"]) {
      bucket.averages[field] = rounded(average(participantRows, field));
    }
    const elapsedMs = Math.max(0, Number(last?.sampledAt) - Number(first?.sampledAt));
    bucket.elapsedMs = Number.isFinite(elapsedMs) ? elapsedMs : null;
    for (const field of ["jsHeapUsed", "nodes", "listeners", "documents", "layoutCount", "recalcStyleCount"]) {
      const before = Number(first?.[field]);
      const after = Number(last?.[field]);
      const delta = Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
      bucket.beforeAfter[field] = delta;
      bucket.perMinute[field] = delta !== null && elapsedMs > 0 ? rounded((delta * 60_000) / elapsedMs) : null;
    }
    participants[participant] = bucket;
  }
  return {
    sampleCount: samples.length,
    liveSampleCount: liveSamples.length,
    setupSampleCount: samples.length - liveSamples.length,
    driftCount: drift.length,
    maxDriftMs: drift.length === 0 ? null : Math.max(...drift.map((row) => Math.abs(Number(row.driftMs) || 0))),
    host: {
      sampleCount: hostLoadRows.length,
      availableParallelism: hostLoadRows.at(-1)?.hostAvailableParallelism ?? null,
      averageLoad1m: rounded(average(hostLoadRows, "hostLoad1m")),
      maxLoad1m: hostLoadRows.length === 0 ? null : rounded(Math.max(...hostLoadRows.map((row) => row.hostLoad1m))),
      maxLoad5m: hostLoadRows.length === 0 ? null : rounded(Math.max(...hostLoadRows.map((row) => row.hostLoad5m))),
      maxLoad15m: hostLoadRows.length === 0 ? null : rounded(Math.max(...hostLoadRows.map((row) => row.hostLoad15m))),
    },
    errorCount: errors.length,
    errors,
    participants,
    processes: summarizeProcesses(processRows),
  };
}

export function summarizeProcesses(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const type = row.processType ?? "unknown";
    const bucket = grouped.get(type) ?? { cpuSecondsDelta: 0, bySample: new Map() };
    if (Number.isFinite(row.cpuTimeDelta)) bucket.cpuSecondsDelta += row.cpuTimeDelta;
    const sample = bucket.bySample.get(row.sampledAt) ?? { cpuPercent: 0, processIds: new Set() };
    if (Number.isFinite(row.cpuPercent)) sample.cpuPercent += row.cpuPercent;
    sample.processIds.add(row.processId);
    bucket.bySample.set(row.sampledAt, sample);
    grouped.set(type, bucket);
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([type, bucket]) => {
      const samples = [...bucket.bySample.values()];
      const cpuPercents = samples.map((sample) => sample.cpuPercent);
      return [
        type,
        {
          samples: samples.length,
          cpuSecondsDelta: rounded(bucket.cpuSecondsDelta, 4),
          averageCpuPercent: cpuPercents.length > 0 ? rounded(cpuPercents.reduce((sum, value) => sum + value, 0) / cpuPercents.length) : null,
          maxCpuPercent: cpuPercents.length > 0 ? rounded(Math.max(...cpuPercents)) : null,
          maxProcessCount: samples.length > 0 ? Math.max(...samples.map((sample) => sample.processIds.size)) : 0,
        },
      ];
    }),
  );
}

export function summarizeSteps(rows) {
  const failures = rows.filter((row) => row.ok === false && row.allowedDisposition !== true);
  const dispositions = rows.filter((row) => row.ok === false && row.allowedDisposition === true);
  const byFeature = {};
  for (const row of rows.filter((candidate) => candidate.event === "step")) {
    const feature = row.feature ?? "workload";
    const bucket = byFeature[feature] ?? { steps: 0, passed: 0, failed: 0, dispositions: 0, totalMs: 0 };
    bucket.steps += 1;
    bucket.passed += row.ok ? 1 : 0;
    bucket.failed += row.ok || row.allowedDisposition === true ? 0 : 1;
    bucket.dispositions += row.allowedDisposition === true ? 1 : 0;
    bucket.totalMs += Number(row.ms) || 0;
    byFeature[feature] = bucket;
  }
  return { total: rows.length, failureCount: failures.length, failures, dispositionCount: dispositions.length, dispositions, byFeature };
}

function summarizeHeapDiffs(diffs) {
  const entries = Array.isArray(diffs) ? diffs : [];
  return entries.map((diff) => ({
    tag: diff.tag,
    before: diff.before,
    after: diff.after,
    nodeCountDelta: diff.nodeCountDelta,
    totalSelfSizeDelta: diff.totalSelfSizeDelta,
    topClasses: (diff.classes ?? []).slice(0, 12),
  }));
}

export function summarizeCpuProfile(profile, file) {
  if (!profile) return { file, present: false };
  const nodes = new Map((profile.nodes ?? []).map((node) => [node.id, node]));
  const totalMicros = (profile.timeDeltas ?? []).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const fallbackMicros = profile.samples?.length > 0 && profile.startTime !== undefined && profile.endTime !== undefined ? (profile.endTime - profile.startTime) / profile.samples.length : 0;
  const frames = new Map();
  for (let index = 0; index < (profile.samples?.length ?? 0); index += 1) {
    const node = nodes.get(profile.samples[index]);
    if (!node) continue;
    const frame = node.callFrame ?? {};
    const key = `${frame.functionName ?? "(anonymous)"}\u0000${frame.url ?? ""}\u0000${frame.lineNumber ?? -1}\u0000${frame.columnNumber ?? -1}`;
    const current = frames.get(key) ?? {
      functionName: frame.functionName || "(anonymous)",
      url: frame.url || "",
      line: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null,
      column: Number.isInteger(frame.columnNumber) ? frame.columnNumber + 1 : null,
      samples: 0,
      selfMicros: 0,
    };
    current.samples += 1;
    current.selfMicros += Number(profile.timeDeltas?.[index]) || fallbackMicros;
    frames.set(key, current);
  }
  const ranked = [...frames.values()]
    .map((entry) => ({
      ...entry,
      selfMs: rounded(entry.selfMicros / 1_000),
      percent: totalMicros > 0 ? rounded((entry.selfMicros * 100) / totalMicros) : null,
    }))
    .sort((left, right) => right.selfMicros - left.selfMicros);
  return {
    file,
    present: true,
    samples: profile.samples?.length ?? 0,
    nodes: profile.nodes?.length ?? 0,
    startTime: profile.startTime ?? null,
    endTime: profile.endTime ?? null,
    durationUs: profile.startTime !== undefined && profile.endTime !== undefined ? profile.endTime - profile.startTime : null,
    sampledMicros: totalMicros,
    topFrames: ranked.slice(0, 30),
    topApplicationFrames: ranked.filter((entry) => isApplicationFrame(entry.url)).slice(0, 30),
  };
}

export function compareReports(before, after) {
  const participantNames = new Set([...Object.keys(before.metrics?.participants ?? {}), ...Object.keys(after.metrics?.participants ?? {})]);
  const metrics = {};
  for (const name of participantNames) {
    const left = before.metrics?.participants?.[name]?.beforeAfter ?? {};
    const right = after.metrics?.participants?.[name]?.beforeAfter ?? {};
    metrics[name] = Object.fromEntries(
      Object.keys({ ...left, ...right }).map((field) => [
        field,
        {
          before: left[field] ?? null,
          after: right[field] ?? null,
          delta: left[field] !== null && right[field] !== null && left[field] !== undefined && right[field] !== undefined ? right[field] - left[field] : null,
        },
      ]),
    );
  }
  const traceFeatures = new Set([...(before.traces ?? []).map((trace) => trace.feature), ...(after.traces ?? []).map((trace) => trace.feature)]);
  const traces = Object.fromEntries(
    [...traceFeatures].map((feature) => {
      const left = before.traces?.find((trace) => trace.feature === feature) ?? { countsPerParticipantSecond: {} };
      const right = after.traces?.find((trace) => trace.feature === feature) ?? { countsPerParticipantSecond: {} };
      const names = new Set([...Object.keys(left.countsPerParticipantSecond ?? {}), ...Object.keys(right.countsPerParticipantSecond ?? {})]);
      return [
        feature,
        Object.fromEntries(
          [...names].map((name) => {
            const beforeRate = left.countsPerParticipantSecond?.[name] ?? 0;
            const afterRate = right.countsPerParticipantSecond?.[name] ?? 0;
            return [
              name,
              {
                before: beforeRate,
                after: afterRate,
                delta: afterRate - beforeRate,
                percent: beforeRate === 0 ? null : rounded(((afterRate - beforeRate) * 100) / beforeRate),
              },
            ];
          }),
        ),
      ];
    }),
  );
  const traceLayers = Object.fromEntries(
    [...traceFeatures].map((feature) => {
      const left = before.traces?.find((trace) => trace.feature === feature) ?? {};
      const right = after.traces?.find((trace) => trace.feature === feature) ?? {};
      const layerMetrics = {};
      for (const field of ["averagePeakLayerCount", "layerPaintsPerParticipantSecond"]) {
        const beforeValue = left[field] ?? null;
        const afterValue = right[field] ?? null;
        layerMetrics[field] = {
          before: beforeValue,
          after: afterValue,
          delta: beforeValue !== null && afterValue !== null ? afterValue - beforeValue : null,
          percent: beforeValue ? rounded(((afterValue - beforeValue) * 100) / beforeValue) : null,
        };
      }
      return [feature, layerMetrics];
    }),
  );
  const processTypes = new Set([...Object.keys(before.metrics?.processes ?? {}), ...Object.keys(after.metrics?.processes ?? {})]);
  const processCpu = Object.fromEntries(
    [...processTypes].map((type) => {
      const beforeValue = before.metrics?.processes?.[type]?.averageCpuPercent ?? null;
      const afterValue = after.metrics?.processes?.[type]?.averageCpuPercent ?? null;
      return [
        type,
        {
          before: beforeValue,
          after: afterValue,
          delta: beforeValue !== null && afterValue !== null ? afterValue - beforeValue : null,
          percent: beforeValue ? rounded(((afterValue - beforeValue) * 100) / beforeValue) : null,
        },
      ];
    }),
  );
  const heapTags = new Set([...(before.heapDiffs ?? []).map((diff) => diff.tag), ...(after.heapDiffs ?? []).map((diff) => diff.tag)]);
  const heapByTag = Object.fromEntries(
    [...heapTags].map((tag) => {
      const left = before.heapDiffs?.find((diff) => diff.tag === tag) ?? {};
      const right = after.heapDiffs?.find((diff) => diff.tag === tag) ?? {};
      return [
        tag,
        Object.fromEntries(
          ["nodeCountDelta", "totalSelfSizeDelta"].map((field) => [
            field,
            {
              before: left[field] ?? null,
              after: right[field] ?? null,
              delta: left[field] !== undefined && right[field] !== undefined ? right[field] - left[field] : null,
            },
          ]),
        ),
      ];
    }),
  );
  return {
    from: before.runId ?? null,
    to: after.runId ?? null,
    metrics,
    traces,
    traceLayers,
    processCpu,
    heap: {
      before: before.heapDiffs ?? [],
      after: after.heapDiffs ?? [],
      byTag: heapByTag,
    },
    cpuProfiles: {
      before: before.cpuProfiles ?? [],
      after: after.cpuProfiles ?? [],
    },
    featureMetrics: compareFeatureMetrics(before.featureMetrics ?? {}, after.featureMetrics ?? {}),
    stepFailures: {
      before: before.steps?.failureCount ?? 0,
      after: after.steps?.failureCount ?? 0,
      delta: (after.steps?.failureCount ?? 0) - (before.steps?.failureCount ?? 0),
    },
  };
}

export async function analyzeRun(runDir) {
  const manifest = await readJson(join(runDir, "manifest.json"), {});
  const metricsRows = await readNdjson(join(runDir, "metrics.ndjson"));
  const stepRows = await readNdjson(join(runDir, "steps.ndjson"));
  const support = await readJson(join(runDir, "feature-support.json"), { features: [] });
  const heapDiffs = await readJson(join(runDir, "heap-diffs.json"), []);
  const entries = await readdir(runDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const traces = [];
  const cpuProfiles = [];
  const traceEntries = await readdir(join(runDir, "traces"), { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of traceEntries) {
    if (entry.isFile() && entry.name.startsWith("trace-") && entry.name.endsWith(".json")) {
      const record = await readJson(join(runDir, "traces", entry.name));
      if (record) traces.push({ ...record, summary: summarizeTrace(record) });
    }
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".cpuprofile")) cpuProfiles.push(summarizeCpuProfile(await readJson(join(runDir, entry.name)), entry.name));
  }
  traces.sort((left, right) => left.feature.localeCompare(right.feature));
  const traceSummaries = aggregateTraceSummaries(traces.map((trace) => trace.summary));
  const steps = summarizeSteps(stepRows);
  return {
    runId: manifest.runId ?? runDir.split("/").pop(),
    status: manifest.status ?? "unknown",
    mode: manifest.mode ?? null,
    durationMs: manifest.durationMs ?? null,
    metrics: summarizeMetrics(metricsRows),
    features: support.features ?? [],
    traces: traceSummaries,
    heapDiffs: summarizeHeapDiffs(heapDiffs),
    cpuProfiles,
    featureMetrics: steps.byFeature,
    steps,
  };
}

export function aggregateTraceSummaries(summaries) {
  const grouped = new Map();
  for (const summary of summaries) {
    const current = grouped.get(summary.feature) ?? { feature: summary.feature, occurrences: 0, durationMs: 0, participantCount: 0, participantMillis: 0, counts: {}, durationsMicros: {}, peakLayerCountSum: 0, maxLayerCount: 0, layerPaintEvents: 0, compositingReasons: {}, functions: new Map() };
    current.occurrences += 1;
    current.durationMs += summary.durationMs ?? 0;
    current.participantCount = Math.max(current.participantCount, summary.participantCount ?? 0);
    current.participantMillis += (summary.durationMs ?? 0) * (summary.participantCount ?? 0);
    current.peakLayerCountSum += summary.maxLayerCount ?? 0;
    current.maxLayerCount = Math.max(current.maxLayerCount, summary.maxLayerCount ?? 0);
    current.layerPaintEvents += summary.layerPaintEvents ?? 0;
    for (const [name, value] of Object.entries(summary.counts ?? {})) current.counts[name] = (current.counts[name] ?? 0) + value;
    for (const [name, value] of Object.entries(summary.durationsMicros ?? {})) current.durationsMicros[name] = (current.durationsMicros[name] ?? 0) + value;
    for (const [reason, count] of Object.entries(summary.compositingReasons ?? {})) current.compositingReasons[reason] = (current.compositingReasons[reason] ?? 0) + count;
    for (const entry of summary.topFunctions ?? []) {
      const key = `${entry.functionName}\u0000${entry.url}\u0000${entry.line ?? -1}`;
      const aggregate = current.functions.get(key) ?? { functionName: entry.functionName, url: entry.url, line: entry.line, calls: 0, durationMicros: 0 };
      aggregate.calls += entry.calls ?? 0;
      aggregate.durationMicros += entry.durationMicros ?? 0;
      current.functions.set(key, aggregate);
    }
    grouped.set(summary.feature, current);
  }
  return [...grouped.values()]
    .map((summary) => {
      const { functions, ...fields } = summary;
      return {
        ...fields,
        countsPerParticipantSecond: Object.fromEntries(Object.entries(summary.counts).map(([name, count]) => [name, summary.participantMillis > 0 ? rounded((count * 1_000) / summary.participantMillis) : null])),
        durationPercent: Object.fromEntries(Object.entries(summary.durationsMicros).map(([name, duration]) => [name, summary.participantMillis > 0 ? rounded((duration * 100) / (summary.participantMillis * 1_000)) : null])),
        averagePeakLayerCount: summary.occurrences > 0 ? rounded(summary.peakLayerCountSum / summary.occurrences) : null,
        layerPaintsPerParticipantSecond: summary.participantMillis > 0 ? rounded((summary.layerPaintEvents * 1_000) / summary.participantMillis) : null,
        topFunctions: [...functions.values()].sort((left, right) => right.durationMicros - left.durationMicros).slice(0, 30),
      };
    })
    .sort((left, right) => left.feature.localeCompare(right.feature));
}

function compareFeatureMetrics(before, after) {
  const features = new Set([...Object.keys(before), ...Object.keys(after)]);
  return Object.fromEntries(
    [...features].map((feature) => {
      const left = before[feature] ?? {};
      const right = after[feature] ?? {};
      return [
        feature,
        {
          stepsDelta: (right.steps ?? 0) - (left.steps ?? 0),
          passedDelta: (right.passed ?? 0) - (left.passed ?? 0),
          failedDelta: (right.failed ?? 0) - (left.failed ?? 0),
          dispositionsDelta: (right.dispositions ?? 0) - (left.dispositions ?? 0),
          totalMsDelta: (right.totalMs ?? 0) - (left.totalMs ?? 0),
        },
      ];
    }),
  );
}

export function reportJson(report) {
  return JSON.stringify(report, null, 2);
}
