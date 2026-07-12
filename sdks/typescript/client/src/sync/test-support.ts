import { Clock, Deferred, Effect, Fiber, Layer, ManagedRuntime } from "effect";
import { TestClock } from "effect/testing";
import {
  SyncCodecService,
  SyncEngineService,
  SyncLifecycleService,
  SyncPendingStoreService,
  SyncPolicyService,
  SyncTimeService,
  SyncTransportService,
  makeSyncEngineLayerFromServices,
  type SyncEngineEffectService,
  type SyncPolicyCapability,
  type SyncTimeCapability,
  type SyncTransportCapability,
} from "../effect";
import { InMemoryPendingCommandStore, type PendingCommandStore } from "./persistence";
import { jsonSyncProtocolCodec, type SyncProtocolCodec } from "./protocol";
import type { ControlEvent, ControlState, SyncClock, SyncIdGenerator, SyncLifecycle, SyncSnapshot, SyncSocket, SyncWebSocketFactory } from "./types";

export const participantSessionId = "participant-session-me";
export const stateSchemaVersion = 1;

type TestEventBase = {
  readonly eventId: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly commandId?: string;
  readonly lifecycleIntentId?: string;
  readonly stateSchemaVersion?: number;
  readonly resultingStateDigest?: string;
};

export type TestEventFields =
  | (TestEventBase & { readonly name: "participant_joined"; readonly payload: { readonly participantSessionId: string; readonly displayName: string } })
  | (TestEventBase & { readonly name: "participant_left"; readonly payload: { readonly participantSessionId: string } })
  | (TestEventBase & { readonly name: "hand_raised" | "hand_lowered"; readonly payload: { readonly participantSessionId: string } })
  | (TestEventBase & { readonly name: "session_ended"; readonly payload: Record<string, never> });

export function event(fields: TestEventFields): ControlEvent & { readonly type: "event" } {
  switch (fields.name) {
    case "participant_joined":
      return { type: "event", ...fields, stateSchemaVersion: fields.stateSchemaVersion ?? stateSchemaVersion, resultingStateDigest: fields.resultingStateDigest ?? "0".repeat(64) };
    case "participant_left":
      return { type: "event", ...fields, stateSchemaVersion: fields.stateSchemaVersion ?? stateSchemaVersion, resultingStateDigest: fields.resultingStateDigest ?? "0".repeat(64) };
    case "hand_raised":
    case "hand_lowered":
      return { type: "event", ...fields, stateSchemaVersion: fields.stateSchemaVersion ?? stateSchemaVersion, resultingStateDigest: fields.resultingStateDigest ?? "0".repeat(64) };
    case "session_ended":
      return { type: "event", ...fields, stateSchemaVersion: fields.stateSchemaVersion ?? stateSchemaVersion, resultingStateDigest: fields.resultingStateDigest ?? "0".repeat(64) };
  }
}

export function setHand(state: ControlState, handRaised: boolean): ControlState {
  return { ...state, participants: state.participants.map((participant) => ({ ...participant, handRaised })) };
}

export function ids(...values: string[]): SyncIdGenerator {
  let index = 0;
  return { next: () => values[index++] ?? "command-00000099" };
}

export function sent(socket: ScriptedSocket): unknown[] {
  return socket.sent.map((frame) => JSON.parse(frame));
}

type DeliveryAcknowledgement = {
  readonly type: "delivery_ack";
  readonly stream: "control";
  readonly revision: number;
  readonly stateDigest: string;
};

type RecoveryAcknowledgement = {
  readonly type: "recovery_ack";
  readonly recoveryId: string;
  readonly revision: number;
  readonly stateDigest: string;
};

export function isDeliveryAck(frame: unknown): frame is DeliveryAcknowledgement {
  return typeof frame === "object" && frame !== null && "type" in frame && frame.type === "delivery_ack";
}

export function isRecoveryAck(frame: unknown): frame is RecoveryAcknowledgement {
  return typeof frame === "object" && frame !== null && "type" in frame && frame.type === "recovery_ack";
}

export class ScriptedSocket implements SyncSocket {
  onopen: (() => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onclose: ((event: { readonly code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];
  readonly closeCalls: { readonly code?: number; readonly reason?: string }[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) });
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  closeFromServer(code: number): void {
    this.onclose?.({ code });
  }

  fail(): void {
    this.onerror?.();
  }
}

export type ScriptedTransport = {
  readonly sockets: readonly ScriptedSocket[];
  readonly webSocket: SyncWebSocketFactory;
  readonly layer: Layer.Layer<SyncTransportService>;
  latest(): ScriptedSocket;
  setToken(token: string): void;
};

export function makeScriptedTransport(token = "token"): ScriptedTransport {
  const sockets: ScriptedSocket[] = [];
  let currentToken = token;
  const webSocket: SyncWebSocketFactory = {
    connect() {
      const socket = new ScriptedSocket();
      sockets.push(socket);
      return socket;
    },
  };
  const transport: SyncTransportCapability = {
    url: "ws://sync.test/v2/sync",
    token: async () => currentToken,
    webSocket,
  };

  return {
    sockets,
    webSocket,
    layer: Layer.succeed(SyncTransportService, transport),
    latest() {
      const socket = sockets.at(-1);
      if (!socket) {
        throw new Error("missing scripted socket");
      }
      return socket;
    },
    setToken(token) {
      currentToken = token;
    },
  };
}

export function makeSyncTestTimeLayer(options: SyncTimeCapability = {}): Layer.Layer<SyncTimeService> {
  return Layer.effect(
    SyncTimeService,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const time: Required<SyncTimeCapability> = {
        clock: options.clock ?? callbackClock(clock),
        ids: options.ids ?? ids(),
        random: options.random ?? (() => 0.5),
      };
      return time;
    }),
  );
}

function callbackClock(clock: Clock.Clock): SyncClock {
  return {
    now: () => clock.currentTimeMillisUnsafe(),
    setTimeout(callback, milliseconds) {
      return Effect.runFork(Effect.sleep(milliseconds).pipe(Effect.andThen(Effect.sync(callback)), Effect.provideService(Clock.Clock, clock)));
    },
    clearTimeout(handle) {
      if (Fiber.isFiber(handle)) {
        handle.interruptUnsafe();
      }
    },
  };
}

export type SyncHarnessOptions = {
  readonly codec?: SyncProtocolCodec;
  readonly ids?: SyncTimeCapability["ids"];
  readonly lifecycle?: SyncLifecycle;
  readonly pendingStore?: PendingCommandStore;
  readonly policy?: SyncPolicyCapability;
  readonly token?: string;
};

export type SyncHarness = {
  readonly engine: SyncEngineEffectService;
  readonly transport: ScriptedTransport;
  advance(duration: number): Promise<void>;
  dispose(): Promise<void>;
  run<A, E>(effect: Effect.Effect<A, E>): Promise<A>;
  settle(): Promise<void>;
  waitFor(predicate: (snapshot: SyncSnapshot) => boolean): Promise<void>;
};

export function makeSyncHarness(options: SyncHarnessOptions = {}): SyncHarness {
  const transport = makeScriptedTransport(options.token);
  const timeLayer = makeSyncTestTimeLayer({ ids: options.ids }).pipe(Layer.provideMerge(TestClock.layer({ warningDelay: "1 hour" })));
  const layer = makeSyncEngineLayerFromServices().pipe(
    Layer.provideMerge([
      transport.layer,
      Layer.succeed(SyncPendingStoreService, options.pendingStore ?? new InMemoryPendingCommandStore()),
      timeLayer,
      Layer.succeed(SyncLifecycleService, options.lifecycle),
      Layer.succeed(SyncCodecService, options.codec ?? jsonSyncProtocolCodec),
      Layer.succeed(SyncPolicyService, options.policy ?? {}),
    ]),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = runtime.runSync(Effect.service(SyncEngineService));

  return {
    engine,
    transport,
    advance(duration) {
      return runtime.runPromise(TestClock.adjust(duration).pipe(Effect.andThen(Effect.yieldNow)));
    },
    dispose() {
      return runtime.dispose();
    },
    run(effect) {
      return runtime.runPromise(effect);
    },
    settle() {
      return runtime.runPromise(Effect.yieldNow.pipe(Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow), Effect.andThen(Effect.yieldNow)));
    },
    waitFor(predicate) {
      const gate = Deferred.makeUnsafe<void>();
      let unsubscribe: (() => void) | undefined;
      unsubscribe = engine.subscribe((snapshot) => {
        if (!predicate(snapshot)) {
          return;
        }
        unsubscribe?.();
        Effect.runSync(Deferred.succeed(gate, undefined));
      });
      return runtime.runPromise(Deferred.await(gate));
    },
  };
}
