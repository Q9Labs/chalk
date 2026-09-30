import { Context, Effect, Layer, Scope } from "effect";
import type { ConnectionLifecycleCapability } from "../connection";
import { SpaceClientError } from "./errors";
import { SpaceStore } from "./store";
import type { OfflineAction, OfflineActionKind, OfflineActionsPolicy, OfflineSlice } from "./types";

type Waiter = { readonly action: OfflineAction; readonly resume: (effect: Effect.Effect<void, SpaceClientError>) => void };

/** Public controller: the user decides what happens to actions held while offline. */
export type OfflineActionsControllerEffects = {
  readonly send: () => Effect.Effect<void>;
  readonly discard: () => Effect.Effect<void>;
  readonly setPolicy: (policy: OfflineActionsPolicy) => Effect.Effect<void>;
  readonly dispose: () => void;
};

/** Internal seam used by the chat and participants controllers. */
export type OfflineActionsHold = {
  /** Returns the held version of `run`, or null when the connection is live and nothing is waiting. */
  readonly hold: <A, E>(input: { readonly kind: OfflineActionKind; readonly text?: string }, run: () => Effect.Effect<A, E>) => Effect.Effect<A, E | SpaceClientError> | null;
};

export class OfflineActionsService extends Context.Service<OfflineActionsService, OfflineActionsControllerEffects & OfflineActionsHold>()("@chalk/client/OfflineActions") {}

const discardedError = () => new SpaceClientError({ code: "offline.discarded", recoverable: false, message: "This action was not sent." });

/** Holds actions taken while the connection is reconnecting, then applies the policy once it is live again. */
export const makeOfflineActions = (input: { readonly connection: ConnectionLifecycleCapability; readonly store: SpaceStore }): Effect.Effect<OfflineActionsControllerEffects & OfflineActionsHold, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = new OfflineActionsRuntime(input.connection, input.store);
    yield* Effect.addFinalizer(() => Effect.sync(() => runtime.dispose()));
    return runtime;
  });

export const makeOfflineActionsLayer = (input: Parameters<typeof makeOfflineActions>[0]) => Layer.effect(OfflineActionsService, makeOfflineActions(input));

class OfflineActionsRuntime implements OfflineActionsControllerEffects, OfflineActionsHold {
  readonly #connection: ConnectionLifecycleCapability;
  readonly #store: SpaceStore;
  readonly #unsubscribe: () => void;
  #waiters: readonly Waiter[] = [];
  #decisionNeeded = false;
  #policy: OfflineActionsPolicy = "send";

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore) {
    this.#connection = connection;
    this.#store = store;
    this.#unsubscribe = connection.subscribe(() => this.#connectionChanged());
  }

  send = (): Effect.Effect<void> => Effect.sync(() => this.#settle("send"));
  discard = (): Effect.Effect<void> => Effect.sync(() => this.#settle("discard"));
  setPolicy = (policy: OfflineActionsPolicy): Effect.Effect<void> =>
    Effect.sync(() => {
      this.#policy = policy;
      if (this.#decisionNeeded && policy !== "ask") this.#settle(policy);
      else this.#publish();
    });

  hold = <A, E>(input: { readonly kind: OfflineActionKind; readonly text?: string }, run: () => Effect.Effect<A, E>): Effect.Effect<A, E | SpaceClientError> | null => {
    if (this.#connection.getSnapshot().state !== "reconnecting" && !this.#decisionNeeded) return null;
    const action: OfflineAction = Object.freeze({ id: this.#connection.createId(), kind: input.kind, text: input.text ?? null, queuedAt: this.#connection.nowUnsafe() });
    return Effect.callback<void, SpaceClientError>((resume) => {
      this.#waiters = [...this.#waiters, { action, resume }];
      this.#publish();
      return Effect.sync(() => this.#drop(action.id));
    }).pipe(Effect.andThen(run()));
  };

  dispose(): void {
    this.#unsubscribe();
    this.#settle("discard");
  }

  #connectionChanged(): void {
    if (this.#waiters.length === 0) return;
    const state = this.#connection.getSnapshot().state;
    if (state === "live") {
      if (this.#policy === "ask") {
        this.#decisionNeeded = true;
        this.#publish();
      } else this.#settle(this.#policy);
    } else if (state !== "reconnecting") this.#settle("discard");
  }

  #settle(decision: "send" | "discard"): void {
    const waiters = this.#waiters;
    this.#waiters = [];
    this.#decisionNeeded = false;
    this.#publish();
    for (const waiter of waiters) waiter.resume(decision === "send" ? Effect.void : Effect.fail(discardedError()));
  }

  #drop(id: string): void {
    const next = this.#waiters.filter((waiter) => waiter.action.id !== id);
    if (next.length === this.#waiters.length) return;
    this.#waiters = next;
    if (next.length === 0) this.#decisionNeeded = false;
    this.#publish();
  }

  #publish(): void {
    const slice: OfflineSlice = Object.freeze({ pending: Object.freeze(this.#waiters.map((waiter) => waiter.action)), decisionNeeded: this.#decisionNeeded, policy: this.#policy });
    this.#store.updateOffline(slice);
  }
}
