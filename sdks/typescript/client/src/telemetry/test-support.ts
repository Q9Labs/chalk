import { Deferred, Effect, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import { TelemetryDeliveryService, TelemetryExportFailure, TelemetryExporterService, TelemetryStorageService, makeTelemetryDeliveryLayerFromServices, type TelemetryDeliveryEffectService, type TelemetryDeliveryOptions } from "./delivery";
import type { JourneyIntakeEvent, JourneyIntakeResponse } from "./types";
import type { TelemetryExporter, TelemetryExportOptions } from "./exporter";
import type { TelemetryEvent } from "./types";

export type RecordedExport = {
  readonly events: readonly { readonly event_id: string; readonly name: string; readonly journey_id: string }[];
  readonly options?: TelemetryExportOptions;
};

type ExportStep = { readonly _tag: "succeed" } | { readonly _tag: "fail"; readonly error: TelemetryExportFailure } | { readonly _tag: "wait"; readonly gate: Deferred.Deferred<void>; readonly next: ExportStep };

export type ScriptedExporter = {
  readonly calls: RecordedExport[];
  readonly layer: Layer.Layer<TelemetryExporterService>;
  failNext(cause: unknown, retriable: boolean): void;
  waitNext(next?: "succeed" | { readonly cause: unknown; readonly retriable: boolean }): () => void;
};

export function makeScriptedExporter(): ScriptedExporter {
  const calls: RecordedExport[] = [];
  const steps: ExportStep[] = [];
  const layer = Layer.succeed(TelemetryExporterService, {
    configured: true,
    export: (events, options) =>
      Effect.suspend(() => {
        calls.push({ events, ...(options ? { options } : {}) });
        return runExportStep(steps.shift() ?? { _tag: "succeed" });
      }),
  });

  return {
    calls,
    layer,
    failNext(cause, retriable) {
      steps.push({ _tag: "fail", error: new TelemetryExportFailure({ cause, retriable }) });
    },
    waitNext(next = "succeed") {
      const gate = Deferred.makeUnsafe<void>();
      steps.push({
        _tag: "wait",
        gate,
        next: next === "succeed" ? { _tag: "succeed" } : { _tag: "fail", error: new TelemetryExportFailure(next) },
      });
      return () => {
        Effect.runSync(Deferred.succeed(gate, undefined));
      };
    },
  };
}

function runExportStep(step: ExportStep): Effect.Effect<void, TelemetryExportFailure> {
  switch (step._tag) {
    case "succeed":
      return Effect.void;
    case "fail":
      return Effect.fail(step.error);
    case "wait":
      return Deferred.await(step.gate).pipe(Effect.andThen(runExportStep(step.next)));
  }
}

export type ScriptedStorage = {
  readonly saves: readonly (readonly TelemetryEvent[])[];
  readonly layer: Layer.Layer<TelemetryStorageService>;
  resolveLoad(events: readonly TelemetryEvent[]): void;
};

export function makeScriptedStorage(options: { readonly load?: readonly TelemetryEvent[]; readonly waitForLoad?: boolean } = {}): ScriptedStorage {
  const loadGate = Deferred.makeUnsafe<readonly TelemetryEvent[]>();
  const saves: (readonly TelemetryEvent[])[] = [];
  const layer = Layer.succeed(TelemetryStorageService, {
    configured: true,
    load: options.waitForLoad ? Deferred.await(loadGate) : Effect.succeed(options.load ?? []),
    save: (events) =>
      Effect.sync(() => {
        saves.push([...events]);
      }),
  });

  return {
    saves,
    layer,
    resolveLoad(events) {
      Effect.runSync(Deferred.succeed(loadGate, events));
    },
  };
}

export type DeferredFacadeExport = {
  release(): void;
  started(): Promise<void>;
};

export type DeferredFacadeExporter = {
  readonly calls: RecordedExport[];
  readonly exporter: TelemetryExporter;
  holdNext(): DeferredFacadeExport;
};

export function makeDeferredFacadeExporter(): DeferredFacadeExporter {
  const calls: RecordedExport[] = [];
  const holds: { readonly gate: Deferred.Deferred<void>; readonly started: Deferred.Deferred<void> }[] = [];

  return {
    calls,
    exporter: async (events, options) => {
      calls.push({ events, ...(options ? { options } : {}) });
      const hold = holds.shift();
      if (hold) {
        Effect.runSync(Deferred.succeed(hold.started, undefined));
        await Effect.runPromise(Deferred.await(hold.gate));
      }
      return exportResponse(events);
    },
    holdNext() {
      const hold = { gate: Deferred.makeUnsafe<void>(), started: Deferred.makeUnsafe<void>() };
      holds.push(hold);
      return {
        release() {
          Effect.runSync(Deferred.succeed(hold.gate, undefined));
        },
        started() {
          return Effect.runPromise(Deferred.await(hold.started));
        },
      };
    },
  };
}

function exportResponse(events: readonly JourneyIntakeEvent[]): JourneyIntakeResponse {
  return { accepted_count: events.length, duplicate_count: 0 };
}

export type DeliveryHarness = {
  readonly delivery: TelemetryDeliveryEffectService;
  adjust(duration: number): Promise<void>;
  ready(): Promise<void>;
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  settle(): Promise<void>;
  dispose(): Promise<void>;
};

export function makeDeliveryHarness(options: Omit<TelemetryDeliveryOptions, "exporter" | "storage">, exporter = makeScriptedExporter(), storage = makeScriptedStorage()): DeliveryHarness {
  const layer = makeTelemetryDeliveryLayerFromServices(options).pipe(Layer.provideMerge([exporter.layer, storage.layer, TestClock.layer({ warningDelay: "1 hour" })]));
  const runtime = ManagedRuntime.make(layer);
  const delivery = runtime.runSync(Effect.service(TelemetryDeliveryService));

  return {
    delivery,
    adjust(duration) {
      return runtime.runPromise(TestClock.adjust(duration).pipe(Effect.andThen(Effect.yieldNow)));
    },
    ready() {
      return runtime.runPromise(delivery.awaitReady());
    },
    settle() {
      return runtime.runPromise(Effect.yieldNow);
    },
    run(effect) {
      return runtime.runPromise(effect);
    },
    dispose() {
      return runtime.dispose();
    },
  };
}
