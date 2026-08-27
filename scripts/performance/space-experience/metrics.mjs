import { createWriteStream } from "node:fs";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";

const PAGE_METRIC_FIELDS = ["Nodes", "JSEventListeners", "Documents", "JSHeapUsedSize", "JSHeapTotalSize", "ScriptDuration", "TaskDuration", "LayoutCount", "RecalcStyleCount", "LayoutDuration", "RecalcStyleDuration"];

export function sanitizePageUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function hostLoadSample(values = loadavg(), parallelism = availableParallelism()) {
  return {
    hostLoad1m: Number(values[0] ?? 0),
    hostLoad5m: Number(values[1] ?? 0),
    hostLoad15m: Number(values[2] ?? 0),
    hostAvailableParallelism: Number(parallelism),
  };
}

export async function enableCdpDomains(cdp) {
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  await cdp.send("Profiler.enable");
}

async function samplePage(cdp, page) {
  const [performanceResult, memoryResult] = await Promise.allSettled([
    cdp.send("Performance.getMetrics"),
    page.evaluate(() => {
      const value = window.performance?.memory;
      return value
        ? {
            usedJSHeapSize: value.usedJSHeapSize,
            totalJSHeapSize: value.totalJSHeapSize,
            jsHeapSizeLimit: value.jsHeapSizeLimit,
          }
        : null;
    }),
  ]);
  if (performanceResult.status === "rejected") throw performanceResult.reason;
  const { metrics } = performanceResult.value;
  const memory = memoryResult.status === "fulfilled" ? memoryResult.value : null;
  const byName = Object.fromEntries(metrics.map((entry) => [entry.name, entry.value]));
  return {
    sampledAt: Date.now(),
    url: sanitizePageUrl(page.url()),
    nodes: byName.Nodes ?? null,
    listeners: byName.JSEventListeners ?? null,
    documents: byName.Documents ?? null,
    jsHeapUsed: byName.JSHeapUsedSize ?? null,
    jsHeapTotal: byName.JSHeapTotalSize ?? null,
    scriptDuration: byName.ScriptDuration ?? null,
    taskDuration: byName.TaskDuration ?? null,
    layoutCount: byName.LayoutCount ?? null,
    recalcStyleCount: byName.RecalcStyleCount ?? null,
    layoutDuration: byName.LayoutDuration ?? null,
    recalcStyleDuration: byName.RecalcStyleDuration ?? null,
    memory,
    memoryError: memoryResult.status === "rejected" ? (memoryResult.reason instanceof Error ? memoryResult.reason.message : String(memoryResult.reason)) : null,
    availableMetrics: PAGE_METRIC_FIELDS.filter((field) => byName[field] !== undefined),
  };
}

async function sampleProcesses(cdp) {
  const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
  return {
    sampledAt: Date.now(),
    processes: processInfo.map((process) => ({
      id: process.id,
      type: process.type,
      cpuTime: process.cpuTime,
    })),
  };
}

export function deltaSample(previous, current) {
  if (!previous || !current) return {};
  const fields = ["jsHeapUsed", "nodes", "listeners", "documents", "layoutCount", "recalcStyleCount", "scriptDuration", "taskDuration", "layoutDuration", "recalcStyleDuration"];
  return Object.fromEntries(
    fields.map((field) => {
      const before = Number(previous[field]);
      const after = Number(current[field]);
      const hasValues = previous[field] !== null && previous[field] !== undefined && current[field] !== null && current[field] !== undefined;
      const delta = hasValues && Number.isFinite(before) && Number.isFinite(after) ? after - before : null;
      return [`${field}Delta`, delta === null ? null : Number(delta.toFixed(4))];
    }),
  );
}

function errorSample(participant, participantIndex, scheduledAt, startedAt, clock, error) {
  const sampledAt = clock();
  return {
    kind: "error",
    participant,
    participantIndex,
    scheduledAt,
    sampledAt,
    sampleDurationMs: sampledAt - startedAt,
    driftMs: sampledAt - scheduledAt,
    error: error instanceof Error ? error.message : String(error),
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createMetricsSampler({ participants, browserCdp = null, metricsPath, intervalMs = 5_000, sample = samplePage, sampleBrowserProcesses = sampleProcesses, append = appendFile, clock = Date.now }) {
  let active = false;
  let loopPromise = null;
  let failure = null;
  const sampleErrors = [];
  const previous = new Map();
  const previousProcesses = new Map();

  async function write(row) {
    await append(metricsPath, `${JSON.stringify(row)}\n`);
  }

  async function sampleTick(scheduledAt) {
    const tickStarted = clock();
    await write({
      kind: "drift",
      scheduledAt,
      sampledAt: tickStarted,
      driftMs: tickStarted - scheduledAt,
      ...hostLoadSample(),
    });
    for (const person of participants) {
      const startedAt = clock();
      try {
        const current = await sample(person.cdp, person.page);
        const prior = previous.get(person.index);
        previous.set(person.index, current);
        await write({
          kind: "sample",
          participant: person.name,
          participantIndex: person.index,
          scheduledAt,
          sampledAt: current.sampledAt,
          sampleDurationMs: clock() - startedAt,
          driftMs: current.sampledAt - scheduledAt,
          ...current,
          ...deltaSample(prior, current),
        });
      } catch (error) {
        const detail = errorSample(person.name, person.index, scheduledAt, startedAt, clock, error);
        sampleErrors.push(detail);
        await write(detail);
      }
    }
    if (browserCdp) {
      const startedAt = clock();
      try {
        const snapshot = await sampleBrowserProcesses(browserCdp);
        for (const process of snapshot.processes) {
          const prior = previousProcesses.get(process.id);
          const elapsedMs = prior ? snapshot.sampledAt - prior.sampledAt : null;
          const cpuTimeDelta = prior && process.cpuTime >= prior.cpuTime ? process.cpuTime - prior.cpuTime : null;
          previousProcesses.set(process.id, { sampledAt: snapshot.sampledAt, cpuTime: process.cpuTime });
          await write({
            kind: "process",
            processId: process.id,
            processType: process.type,
            scheduledAt,
            sampledAt: snapshot.sampledAt,
            driftMs: snapshot.sampledAt - scheduledAt,
            cpuTime: process.cpuTime,
            cpuTimeDelta,
            cpuPercent: cpuTimeDelta !== null && elapsedMs > 0 ? (cpuTimeDelta * 100_000) / elapsedMs : null,
          });
        }
      } catch (error) {
        const detail = errorSample("browser-processes", null, scheduledAt, startedAt, clock, error);
        sampleErrors.push(detail);
        await write(detail);
      }
    }
    return clock() - tickStarted;
  }

  async function run() {
    let scheduledAt = clock();
    while (active) {
      const elapsed = await sampleTick(scheduledAt);
      scheduledAt += intervalMs;
      const waitMs = Math.max(0, scheduledAt - clock());
      if (active && waitMs > 0) await sleep(waitMs);
      if (active && elapsed > intervalMs * 4) scheduledAt = clock();
    }
  }

  return {
    start() {
      if (active) throw new Error("metrics sampler already started");
      active = true;
      loopPromise = run().catch((error) => {
        failure = error;
        active = false;
      });
    },
    async stop() {
      active = false;
      if (loopPromise) await loopPromise;
      if (failure) throw failure;
      if (sampleErrors.length > 0)
        throw new AggregateError(
          sampleErrors.map((row) => new Error(row.error)),
          "metrics sampler recorded sample errors",
        );
    },
    get sampleErrors() {
      return [...sampleErrors];
    },
  };
}

export async function startCpuProfile(cdp, samplingIntervalUs = 5_000) {
  await cdp.send("Profiler.setSamplingInterval", { interval: samplingIntervalUs });
  await cdp.send("Profiler.start");
}

export async function stopCpuProfile(cdp, filePath) {
  const { profile } = await cdp.send("Profiler.stop");
  await writeFile(filePath, JSON.stringify(profile));
  return {
    samples: profile.samples?.length ?? 0,
    nodes: profile.nodes?.length ?? 0,
    startTime: profile.startTime ?? null,
    endTime: profile.endTime ?? null,
    durationUs: profile.endTime !== undefined && profile.startTime !== undefined ? profile.endTime - profile.startTime : null,
    file: filePath,
  };
}

export async function takeHeapSnapshot(cdp, filePath) {
  await cdp.send("HeapProfiler.collectGarbage");
  const stream = createWriteStream(filePath);
  const finished = new Promise((resolve, reject) => {
    stream.once("finish", resolve);
    stream.once("error", reject);
  });
  const onChunk = ({ chunk }) => stream.write(chunk);
  cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
  try {
    await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
  } finally {
    cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
    stream.end();
  }
  await finished;
  return filePath;
}

export async function summarizeHeapSnapshot(filePath) {
  const snapshot = JSON.parse(await readFile(filePath, "utf8"));
  const strings = snapshot.strings;
  const fields = snapshot.snapshot.meta.node_fields;
  const width = fields.length;
  const nameIndex = fields.indexOf("name");
  const sizeIndex = fields.indexOf("self_size");
  const byClass = new Map();
  let totalSelfSize = 0;
  let nodeCount = 0;
  for (let offset = 0; offset < snapshot.nodes.length; offset += width) {
    const size = snapshot.nodes[offset + sizeIndex];
    const rawName = snapshot.nodes[offset + nameIndex];
    const name = typeof rawName === "number" ? strings[rawName] : String(rawName);
    const current = byClass.get(name) ?? { count: 0, selfSize: 0 };
    current.count += 1;
    current.selfSize += size;
    byClass.set(name, current);
    nodeCount += 1;
    totalSelfSize += size;
  }
  const classes = Object.fromEntries([...byClass.entries()].map(([name, values]) => [name, values]));
  return {
    file: filePath,
    nodeCount,
    totalSelfSize,
    classes,
    top: [...byClass.entries()]
      .sort((left, right) => right[1].selfSize - left[1].selfSize)
      .slice(0, 30)
      .map(([name, values]) => ({ name, ...values })),
  };
}

export function diffHeapSummaries(before, after) {
  const names = new Set([...Object.keys(before.classes ?? {}), ...Object.keys(after.classes ?? {})]);
  const classes = [...names]
    .map((name) => {
      const left = before.classes?.[name] ?? { count: 0, selfSize: 0 };
      const right = after.classes?.[name] ?? { count: 0, selfSize: 0 };
      return {
        name,
        countDelta: right.count - left.count,
        selfSizeDelta: right.selfSize - left.selfSize,
        beforeCount: left.count,
        afterCount: right.count,
        beforeSelfSize: left.selfSize,
        afterSelfSize: right.selfSize,
      };
    })
    .filter((entry) => entry.countDelta !== 0 || entry.selfSizeDelta !== 0)
    .sort((left, right) => Math.abs(right.selfSizeDelta) - Math.abs(left.selfSizeDelta));
  return {
    before: before.file,
    after: after.file,
    nodeCountDelta: after.nodeCount - before.nodeCount,
    totalSelfSizeDelta: after.totalSelfSize - before.totalSelfSize,
    classes,
  };
}
