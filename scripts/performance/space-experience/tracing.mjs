import { writeFile } from "node:fs/promises";

const TIMELINE_EVENTS = new Set(["Paint", "PrePaint", "UpdateLayoutTree", "Layout", "RasterTask", "CompositeLayers", "Layerize", "GPUTask", "Commit", "ActivateLayerTree", "DrawFrame", "FunctionCall", "EventDispatch", "RunTask", "TimerFire", "FireAnimationFrame"]);
const DEFAULT_TRACE_COMPLETE_TIMEOUT_MS = 10_000;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function errorRecord(phase, error) {
  const record = { phase, name: error instanceof Error ? error.name : "Error", message: errorMessage(error) };
  if (error instanceof AggregateError) record.causes = error.errors.map((cause) => errorRecord(phase, cause));
  return record;
}

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
  return {
    eventCount: events.length,
    counts,
    durationsMicros,
    topFunctions: [...functions.values()].sort((left, right) => right.durationMicros - left.durationMicros).slice(0, 30),
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function waitForCompletion(deferred, timeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tracing.tracingComplete timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([deferred.promise, timeout]).finally(() => clearTimeout(timer));
}

function layerRecorder(person) {
  const events = {
    latestLayers: [],
    maxLayerCount: 0,
    layerPaintEvents: 0,
    errors: [],
  };
  let enabled = false;
  let listenersAttached = false;

  const onLayerTree = ({ layers = [] } = {}) => {
    events.latestLayers = layers;
    events.maxLayerCount = Math.max(events.maxLayerCount, layers.length);
  };
  const onLayerPainted = () => {
    events.layerPaintEvents += 1;
  };

  function attach() {
    if (listenersAttached) return;
    person.cdp.on("LayerTree.layerTreeDidChange", onLayerTree);
    person.cdp.on("LayerTree.layerPainted", onLayerPainted);
    listenersAttached = true;
  }

  function detach() {
    if (!listenersAttached) return;
    person.cdp.off("LayerTree.layerTreeDidChange", onLayerTree);
    person.cdp.off("LayerTree.layerPainted", onLayerPainted);
    listenersAttached = false;
  }

  return {
    async start() {
      if (enabled) return;
      attach();
      try {
        await person.cdp.send("LayerTree.enable");
        enabled = true;
      } catch (error) {
        detach();
        throw error;
      }
    },
    async compositingReasons() {
      const reasons = {};
      const results = await Promise.allSettled(events.latestLayers.map((layer) => person.cdp.send("LayerTree.compositingReasons", { layerId: layer.layerId })));
      for (const result of results) {
        if (result.status === "rejected") {
          events.errors.push(errorMessage(result.reason));
          continue;
        }
        for (const reason of result.value.compositingReasons ?? []) reasons[reason] = (reasons[reason] ?? 0) + 1;
      }
      return reasons;
    },
    async disable() {
      if (!enabled) {
        detach();
        return;
      }
      try {
        await person.cdp.send("LayerTree.disable");
      } catch (error) {
        events.errors.push(errorMessage(error));
        throw error;
      } finally {
        enabled = false;
        detach();
      }
    },
    dispose() {
      detach();
    },
    isEnabled() {
      return enabled;
    },
    result(compositingReasons = {}) {
      return {
        lastLayerCount: events.latestLayers.length,
        maxLayerCount: events.maxLayerCount,
        drawsContentCount: events.latestLayers.filter((layer) => layer.drawsContent).length,
        layerPaintEvents: events.layerPaintEvents,
        compositingReasons,
        errors: [...events.errors],
      };
    },
  };
}

export function createTraceRecorder({ browserCdp, participants, categories, traceCompleteTimeoutMs = DEFAULT_TRACE_COMPLETE_TIMEOUT_MS }) {
  const layers = participants.map((person) => layerRecorder(person));
  const events = [];
  let complete = null;
  let state = "idle";
  let startPromise = null;
  let stopPromise = null;
  let browserTracingStarted = false;
  let browserListenersAttached = false;
  let compositingReasons = [];
  let result = null;
  let stopErrors = [];

  const onData = ({ value = [] } = {}) => events.push(...value);
  const onComplete = () => complete?.resolve();
  const onError = (error) => complete?.reject(error instanceof Error ? error : new Error(String(error)));

  function attachBrowserListeners() {
    if (browserListenersAttached) return;
    browserCdp.on("Tracing.dataCollected", onData);
    browserCdp.on("Tracing.tracingComplete", onComplete);
    browserCdp.on("Inspector.targetCrashed", onError);
    browserListenersAttached = true;
  }

  function detachBrowserListeners() {
    if (!browserListenersAttached) return;
    browserCdp.off("Tracing.dataCollected", onData);
    browserCdp.off("Tracing.tracingComplete", onComplete);
    browserCdp.off("Inspector.targetCrashed", onError);
    browserListenersAttached = false;
  }

  async function disableLayers() {
    const errors = [];
    await Promise.all(
      layers.map(async (layer) => {
        if (!layer.isEnabled()) {
          layer.dispose();
          return;
        }
        try {
          await layer.disable();
        } catch (error) {
          errors.push(error);
        }
      }),
    );
    for (const layer of layers) layer.dispose();
    return errors;
  }

  async function rollbackLayers() {
    const errors = await disableLayers();
    if (errors.length > 0) throw new AggregateError(errors, "LayerTree rollback failed");
  }

  async function start() {
    if (state === "started") return;
    if (state === "starting") return startPromise;
    if (state === "stopping") return stopPromise;
    state = "starting";
    startPromise = (async () => {
      events.length = 0;
      stopErrors = [];
      result = null;
      complete = createDeferred();
      try {
        for (const layer of layers) await layer.start();
        attachBrowserListeners();
        await browserCdp.send("Tracing.start", {
          traceConfig: {
            recordMode: "recordAsMuchAsPossible",
            includedCategories: categories,
          },
        });
        browserTracingStarted = true;
        state = "started";
      } catch (error) {
        detachBrowserListeners();
        try {
          await rollbackLayers();
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Tracing start and rollback failed");
        }
        state = "idle";
        throw error;
      }
    })();
    try {
      await startPromise;
    } finally {
      startPromise = null;
    }
  }

  function makeResult(stoppedAt = Date.now()) {
    if (result) return result;
    const shared = summarizeEvents(events);
    const participantResults = participants.map((person, index) => ({
      participant: person.name,
      participantIndex: person.index,
      layerTree: layers[index].result(compositingReasons[index] ?? {}),
    }));
    result = {
      participants: participantResults,
      browserTrace: { ...shared, scope: "browser" },
      stoppedAt,
    };
    return result;
  }

  function finishStop() {
    state = "stopping";
    stopPromise = (async () => {
      try {
        compositingReasons = await Promise.all(layers.map((layer) => layer.compositingReasons()));
        if (browserTracingStarted) {
          try {
            await browserCdp.send("Tracing.end");
          } catch (error) {
            stopErrors.push(error);
          }
          if (stopErrors.length === 0) {
            try {
              await waitForCompletion(complete, traceCompleteTimeoutMs);
            } catch (error) {
              stopErrors.push(error);
            }
          }
        }
      } catch (error) {
        stopErrors.push(error);
      } finally {
        browserTracingStarted = false;
        detachBrowserListeners();
        stopErrors.push(...(await disableLayers()));
        state = "idle";
      }
      const traceResult = makeResult(Date.now());
      if (stopErrors.length > 0) {
        const failure = new AggregateError(stopErrors, `Tracing stop failed: ${errorMessage(stopErrors[0])}`);
        failure.result = traceResult;
        throw failure;
      }
      return traceResult;
    })();
    return stopPromise;
  }

  async function stop() {
    if (stopPromise) return stopPromise;
    if (state === "starting") {
      const pendingStart = startPromise;
      stopPromise = (async () => {
        try {
          await pendingStart;
        } catch {
          return makeResult();
        }
        stopPromise = null;
        return finishStop();
      })();
      return stopPromise;
    }
    if (state !== "started") return makeResult();
    return finishStop();
  }

  return {
    start,
    stop,
    dispose() {
      detachBrowserListeners();
      for (const layer of layers) layer.dispose();
    },
    result() {
      return makeResult();
    },
    wasStarted() {
      return state === "started" || state === "stopping" || browserTracingStarted;
    },
  };
}

export async function traceFeature({
  participants,
  browserCdp,
  feature,
  action,
  outputPath,
  observeMs = 1_000,
  categories = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.layers", "cc", "gpu"],
  traceCompleteTimeoutMs = DEFAULT_TRACE_COMPLETE_TIMEOUT_MS,
}) {
  const startedAt = Date.now();
  const recorder = createTraceRecorder({ browserCdp, participants, categories, traceCompleteTimeoutMs });
  let operationError = null;
  let operationPhase = "start";
  let stopError = null;
  let record;
  try {
    await recorder.start();
    operationPhase = "action";
    await action();
    if (observeMs > 0) await new Promise((resolve) => setTimeout(resolve, observeMs));
  } catch (error) {
    operationError = error;
  } finally {
    try {
      const stopped = await recorder.stop();
      record = {
        feature,
        startedAt,
        stoppedAt: stopped.stoppedAt,
        durationMs: stopped.stoppedAt - startedAt,
        participants: stopped.participants,
        browserTrace: stopped.browserTrace,
      };
    } catch (error) {
      stopError = error;
      const stopped = error.result ?? recorder.result();
      record = {
        feature,
        startedAt,
        stoppedAt: stopped.stoppedAt ?? Date.now(),
        durationMs: (stopped.stoppedAt ?? Date.now()) - startedAt,
        participants: stopped.participants,
        browserTrace: stopped.browserTrace,
      };
    }
    recorder.dispose();
    const errors = [];
    if (operationError) errors.push(errorRecord(operationPhase, operationError));
    if (stopError) errors.push(errorRecord("stop", stopError));
    if (errors.length > 0) record.errors = errors;
    await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  if (operationError && stopError) throw new AggregateError([operationError, stopError], `${feature} trace and ${operationPhase} failed`);
  if (stopError) throw stopError;
  if (operationError) throw operationError;
  return record;
}

export function summarizeTrace(record) {
  const participants = record.participants ?? [];
  const eventSources = record.browserTrace ? [record.browserTrace] : participants;
  const counts = {};
  const durationsMicros = {};
  const compositingReasons = {};
  const functions = new Map();
  let maxLayerCount = 0;
  let layerPaintEvents = 0;
  for (const source of eventSources) {
    for (const [name, count] of Object.entries(source.counts ?? {})) counts[name] = (counts[name] ?? 0) + count;
    for (const [name, duration] of Object.entries(source.durationsMicros ?? {})) durationsMicros[name] = (durationsMicros[name] ?? 0) + duration;
    for (const entry of source.topFunctions ?? []) {
      const key = `${entry.functionName}\u0000${entry.url}\u0000${entry.line ?? -1}`;
      const current = functions.get(key) ?? { functionName: entry.functionName, url: entry.url, line: entry.line, calls: 0, durationMicros: 0 };
      current.calls += entry.calls ?? 0;
      current.durationMicros += entry.durationMicros ?? 0;
      functions.set(key, current);
    }
  }
  for (const participant of participants) {
    maxLayerCount = Math.max(maxLayerCount, participant.layerTree?.maxLayerCount ?? 0);
    layerPaintEvents += participant.layerTree?.layerPaintEvents ?? 0;
    for (const [reason, count] of Object.entries(participant.layerTree?.compositingReasons ?? {})) compositingReasons[reason] = (compositingReasons[reason] ?? 0) + count;
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
