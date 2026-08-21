import { Context, Effect, Layer } from "effect";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import type { ConnectionWhiteboardFactoryInput } from "../connection/dependencies";
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "../whiteboard/types";
import { SpaceStore } from "./store";
import type { WhiteboardSlice } from "./types";

const EMPTY_SUMMARY: ChalkWhiteboardSummary = Object.freeze({ status: "unsubscribed", sceneId: null, revision: null, capabilities: Object.freeze([]), canDraw: false, canClear: false, presenting: false, error: null });

export type WhiteboardControllerEffects = { readonly transport: () => ChalkWhiteboardV1Transport | null; readonly dispose: () => void };
export class WhiteboardControllerService extends Context.Service<WhiteboardControllerService, WhiteboardControllerEffects>()("@chalk/client/WhiteboardController") {}

/** The whiteboard transport is a foreign port; lifecycle and cleanup stay scoped. */
export const makeWhiteboardController = (connection: ConnectionLifecycleCapability, store: SpaceStore, create?: (input: ConnectionWhiteboardFactoryInput) => ChalkWhiteboardV1Transport | null): Effect.Effect<WhiteboardControllerEffects, never, import("effect").Scope.Scope> =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const controller = yield* Effect.sync(() => {
      let instance: WhiteboardControllerRuntime | null = null;
      const transport =
        create?.({
          token: () => Effect.runPromiseWith(context)(connection.getSyncToken()),
          onSummary: (summary) => instance?.observe(summary),
        }) ?? null;
      instance = new WhiteboardControllerRuntime(connection, store, transport);
      return instance;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    return controller;
  });

export const makeWhiteboardControllerLayer = (connection: ConnectionLifecycleCapability, store: SpaceStore, create?: (input: ConnectionWhiteboardFactoryInput) => ChalkWhiteboardV1Transport | null) => Layer.effect(WhiteboardControllerService, makeWhiteboardController(connection, store, create));

class WhiteboardControllerRuntime implements WhiteboardControllerEffects {
  readonly #store: SpaceStore;
  readonly #transport: ChalkWhiteboardV1Transport | null;
  #connected = false;
  #summary: ChalkWhiteboardSummary = EMPTY_SUMMARY;
  #unsubscribe: (() => void) | null = null;

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, transport: ChalkWhiteboardV1Transport | null) {
    this.#store = store;
    this.#transport = transport;
    this.#unsubscribe = connection.subscribePorts((ports) => this.#bind(ports));
  }

  transport = (): ChalkWhiteboardV1Transport | null => this.#transport;
  dispose(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#bind(null);
  }

  observe(summary: ChalkWhiteboardSummary): void {
    if (!this.#connected && summary.status !== "unsubscribed") return;
    this.#summary = Object.freeze({
      status: summary.status,
      sceneId: summary.sceneId,
      revision: summary.revision,
      capabilities: Object.freeze([...summary.capabilities]),
      canDraw: summary.canDraw,
      canClear: summary.canClear,
      presenting: summary.presenting,
      error: summary.error ? Object.freeze({ ...summary.error }) : null,
    });
    this.#publish();
  }

  #bind(ports: ConnectionPorts | null): void {
    if (ports) {
      this.#connected = true;
      return;
    }
    if (!this.#connected) return;
    this.#connected = false;
    this.#transport?.stopSceneSubscription();
    this.#summary = EMPTY_SUMMARY;
    this.#publish();
  }

  #publish(): void {
    const slice: WhiteboardSlice = Object.freeze({ open: this.#summary.status !== "unsubscribed", engine: Object.freeze({ status: this.#summary.status, sceneId: this.#summary.sceneId, revision: this.#summary.revision, presenting: this.#summary.presenting, error: this.#summary.error }) });
    const current = this.#store.getSnapshot().whiteboard;
    if (sameWhiteboard(current, slice)) return;
    this.#store.updateWhiteboard(slice);
  }
}

function sameWhiteboard(left: WhiteboardSlice, right: WhiteboardSlice): boolean {
  return left.open === right.open && left.engine.status === right.engine.status && left.engine.sceneId === right.engine.sceneId && left.engine.revision === right.engine.revision && left.engine.presenting === right.engine.presenting && sameError(left.engine.error, right.engine.error);
}
function sameError(left: WhiteboardSlice["engine"]["error"], right: WhiteboardSlice["engine"]["error"]): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.operation === right.operation && left.code === right.code && left.recoverable === right.recoverable && left.message === right.message;
}
