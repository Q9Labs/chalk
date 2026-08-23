import { writeFile } from "node:fs/promises";

const TIMELINE_EVENTS = new Set(["Paint", "PrePaint", "UpdateLayoutTree", "Layout", "RasterTask", "CompositeLayers", "Layerize", "GPUTask", "Commit", "ActivateLayerTree", "DrawFrame", "FunctionCall", "EventDispatch", "RunTask", "TimerFire", "FireAnimationFrame"]);

function summarizeEvents(events) {
  const counts = {};
  const durationsMicros = {};
  const functions = new Map();
  for (const event of events) {
    if (!TIMELINE_EVENTS.has(event.name)) continue;
    counts[event.name] = (counts[event.name] ?? 0) + 1;
    durationsMicros[event.name] = (durationsMicros[event.name] ?? 0) + (event.dur ?? 0);
    if (event.name === "FunctionCall") {
      const data = event.args?.data ?? {};
      const functionName = data.functionName || "(anonymous)";
      const url = data.url || data.scriptName || "";
      const line = Number.isInteger(data.lineNumber) ? data.lineNumber + 1 : null;
      const key = `${functionName}\u0000${url}\u0000${line ?? -1}`;
      const current = functions.get(key) ?? { functionName, url, line, calls: 0, durationMicros: 0 };
      current.calls += 1;
      current.durationMicros += event.dur ?? 0;
      functions.set(key, current);
    }
  }
  return { eventCount: events.length, counts, durationsMicros, topFunctions: [...functions.values()].sort((left, right) => right.durationMicros - left.durationMicros).slice(0, 30) };
}

function traceRecorder(person, categories) {
  const events = [];
  let latestLayers = [];
  let maxLayerCount = 0;
  let layerPaintEvents = 0;
  const layerErrors = [];
  let completeResolve;
  let completeReject;
  const complete = new Promise((resolve, reject) => {
    completeResolve = resolve;
    completeReject = reject;
  });
  const onData = ({ value }) => events.push(...value);
  const onComplete = () => completeResolve();
  const onError = (error) => completeReject(error);
  const onLayerTree = ({ layers = [] }) => {
    latestLayers = layers;
    maxLayerCount = Math.max(maxLayerCount, layers.length);
  };
  const onLayerPainted = () => {
    layerPaintEvents += 1;
  };
  let started = false;
  let layerTreeEnabled = false;

  return {
    async start() {
      person.cdp.on("Tracing.dataCollected", onData);
      person.cdp.on("Tracing.tracingComplete", onComplete);
      person.cdp.on("Inspector.targetCrashed", onError);
      person.cdp.on("LayerTree.layerTreeDidChange", onLayerTree);
      person.cdp.on("LayerTree.layerPainted", onLayerPainted);
      await person.cdp.send("LayerTree.enable");
      layerTreeEnabled = true;
      try {
        await person.cdp.send("Tracing.start", {
          traceConfig: {
            recordMode: "recordAsMuchAsPossible",
            includedCategories: categories,
          },
        });
      } catch (error) {
        await person.cdp.send("LayerTree.disable").catch((disableError) => {
          layerErrors.push(disableError instanceof Error ? disableError.message : String(disableError));
        });
        layerTreeEnabled = false;
        throw error;
      }
      started = true;
    },
    async stop() {
      if (!started) return { eventCount: 0, counts: {}, durationsMicros: {} };
      const reasonResults = await Promise.allSettled(latestLayers.map((layer) => person.cdp.send("LayerTree.compositingReasons", { layerId: layer.layerId })));
      const compositingReasons = {};
      for (const result of reasonResults) {
        if (result.status === "rejected") {
          layerErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
          continue;
        }
        for (const reason of result.value.compositingReasons ?? []) compositingReasons[reason] = (compositingReasons[reason] ?? 0) + 1;
      }
      await person.cdp.send("Tracing.end");
      await complete;
      started = false;
      if (layerTreeEnabled) {
        try {
          await person.cdp.send("LayerTree.disable");
        } catch (error) {
          layerErrors.push(error instanceof Error ? error.message : String(error));
        }
        layerTreeEnabled = false;
      }
      return {
        ...summarizeEvents(events),
        layerTree: {
          lastLayerCount: latestLayers.length,
          maxLayerCount,
          drawsContentCount: latestLayers.filter((layer) => layer.drawsContent).length,
          layerPaintEvents,
          compositingReasons,
          errors: layerErrors,
        },
      };
    },
    dispose() {
      person.cdp.off("Tracing.dataCollected", onData);
      person.cdp.off("Tracing.tracingComplete", onComplete);
      person.cdp.off("Inspector.targetCrashed", onError);
      person.cdp.off("LayerTree.layerTreeDidChange", onLayerTree);
      person.cdp.off("LayerTree.layerPainted", onLayerPainted);
    },
  };
}

export async function traceFeature({ participants, feature, action, outputPath, observeMs = 1_000, categories = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.layers", "cc", "gpu"] }) {
  const recorders = participants.map((person) => traceRecorder(person, categories));
  const startedAt = Date.now();
  const started = new Set();
  let actionError = null;
  const stopErrors = [];
  try {
    const startResults = await Promise.allSettled(
      recorders.map(async (recorder) => {
        await recorder.start();
        started.add(recorder);
      }),
    );
    const startFailure = startResults.find((result) => result.status === "rejected");
    if (startFailure) throw startFailure.reason;
    await action();
    if (observeMs > 0) await new Promise((resolve) => setTimeout(resolve, observeMs));
  } catch (error) {
    actionError = error;
  } finally {
    const stopResults = await Promise.allSettled(recorders.map((recorder) => (started.has(recorder) ? recorder.stop() : Promise.resolve({ eventCount: 0, counts: {}, durationsMicros: {} }))));
    const results = stopResults.map((result) => {
      if (result.status === "fulfilled") return result.value;
      stopErrors.push(result.reason);
      return { eventCount: 0, counts: {}, durationsMicros: {} };
    });
    for (const recorder of recorders) recorder.dispose();
    const stoppedAt = Date.now();
    const record = {
      feature,
      startedAt,
      stoppedAt,
      durationMs: stoppedAt - startedAt,
      participants: participants.map((person, index) => ({ participant: person.name, participantIndex: person.index, ...(results[index] ?? { eventCount: 0, counts: {}, durationsMicros: {} }) })),
    };
    await writeFile(outputPath, JSON.stringify(record, null, 2));
    if (stopErrors.length > 0 && actionError) throw new AggregateError([actionError, ...stopErrors], `${feature} trace and action failed`);
    if (stopErrors.length > 0) throw new AggregateError(stopErrors, `${feature} trace stop failed`);
    if (actionError) throw actionError;
    return record;
  }
}

export function summarizeTrace(record) {
  const participants = record.participants ?? [];
  const counts = {};
  const durationsMicros = {};
  const compositingReasons = {};
  const functions = new Map();
  let maxLayerCount = 0;
  let layerPaintEvents = 0;
  for (const participant of participants) {
    for (const [name, count] of Object.entries(participant.counts ?? {})) counts[name] = (counts[name] ?? 0) + count;
    for (const [name, duration] of Object.entries(participant.durationsMicros ?? {})) durationsMicros[name] = (durationsMicros[name] ?? 0) + duration;
    maxLayerCount = Math.max(maxLayerCount, participant.layerTree?.maxLayerCount ?? 0);
    layerPaintEvents += participant.layerTree?.layerPaintEvents ?? 0;
    for (const [reason, count] of Object.entries(participant.layerTree?.compositingReasons ?? {})) compositingReasons[reason] = (compositingReasons[reason] ?? 0) + count;
    for (const entry of participant.topFunctions ?? []) {
      const key = `${entry.functionName}\u0000${entry.url}\u0000${entry.line ?? -1}`;
      const current = functions.get(key) ?? { functionName: entry.functionName, url: entry.url, line: entry.line, calls: 0, durationMicros: 0 };
      current.calls += entry.calls ?? 0;
      current.durationMicros += entry.durationMicros ?? 0;
      functions.set(key, current);
    }
  }
  const participantSeconds = ((record.durationMs ?? 0) * participants.length) / 1_000;
  return {
    feature: record.feature,
    durationMs: record.durationMs,
    participantCount: participants.length,
    counts,
    durationsMicros,
    maxLayerCount,
    layerPaintEvents,
    compositingReasons,
    topFunctions: [...functions.values()].sort((left, right) => right.durationMicros - left.durationMicros).slice(0, 30),
    countsPerParticipantSecond: Object.fromEntries(Object.entries(counts).map(([name, count]) => [name, participantSeconds > 0 ? count / participantSeconds : null])),
  };
}
