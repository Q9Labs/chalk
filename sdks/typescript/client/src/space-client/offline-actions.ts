import { Context, Effect, Layer, Scope } from "effect";
import type { AccessSubject } from "../access/grant";
import { browserOfflineActionsStorage, decodeOfflineActions, OFFLINE_ACTION_MAX_AGE_MS, type OfflineActionsStorage, type StoredOfflineAction } from "./offline-actions-storage";
import type { ConnectionLifecycleCapability } from "../connection";
import { validateChatMessage } from "./chat-controller-helpers";
import { SpaceClientError } from "./errors";
import { SpaceStore } from "./store";
import type { OfflineActionKind, OfflineActionsPolicy, OfflineSlice } from "./types";

type Waiter = { readonly action: StoredOfflineAction; readonly resume: (effect: Effect.Effect<void, SpaceClientError>) => void };

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
  readonly hold: <A, E>(input: { readonly kind: OfflineActionKind; readonly text?: string; readonly clientMessageId?: string; readonly attachments?: import("./types").ChatSendInput["attachments"] }, run: () => Effect.Effect<A, E>) => Effect.Effect<A, E | SpaceClientError> | null;
};

export class OfflineActionsService extends Context.Service<OfflineActionsService, OfflineActionsControllerEffects & OfflineActionsHold>()("@chalk/client/OfflineActions") {}

const sameSubject = (current: AccessSubject | null, saved: AccessSubject | null): boolean =>
  !!current && !!saved && current.tenantId === saved.tenantId && current.spaceId === saved.spaceId && current.episodeId === saved.episodeId && current.participantId === saved.participantId && current.participantGeneration === saved.participantGeneration;

const terminalConnection = (snapshot: ReturnType<ConnectionLifecycleCapability["getSnapshot"]>): boolean => snapshot.state === "left" || snapshot.state === "leaving" || (snapshot.state === "failed" && !snapshot.failure?.recoverable);
const validStoredAction = (action: StoredOfflineAction, now: number): boolean =>
  Number.isFinite(action.queuedAt) && action.queuedAt <= now && (action.kind !== "chat_message" || (!!action.clientMessageId && action.text !== null && validateChatMessage({ text: action.text, attachments: action.attachments }) === null));

const discardedError = () => new SpaceClientError({ code: "offline.discarded", recoverable: false, message: "This action was not sent." });

/** Holds actions taken while the connection is reconnecting, then applies the policy once it is live again. */
export const makeOfflineActions = (input: { readonly connection: ConnectionLifecycleCapability; readonly store: SpaceStore; readonly storage?: OfflineActionsStorage; readonly storageKey?: string }): Effect.Effect<OfflineActionsControllerEffects & OfflineActionsHold, never, Scope.Scope> =>
  Effect.gen(function* () {
    const runtime = new OfflineActionsRuntime(input.connection, input.store, input.storage ?? browserOfflineActionsStorage(), input.storageKey);
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
  #policyExplicit = false;
  #restored = false;
  #subject: AccessSubject | null = null;
  #notice: string | undefined;
  readonly #storage: OfflineActionsStorage | undefined;
  readonly #storageKey: string;

  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, storage?: OfflineActionsStorage, storageKey = "chalk:offline-actions") {
    this.#connection = connection;
    this.#store = store;
    this.#storage = storage;
    this.#storageKey = storageKey;
    this.#unsubscribe = connection.subscribe(() => this.#connectionChanged());
    this.#connectionChanged();
  }

  send = (): Effect.Effect<void> => Effect.sync(() => this.#settle("send"));
  discard = (): Effect.Effect<void> => Effect.sync(() => this.#settle("discard"));
  setPolicy = (policy: OfflineActionsPolicy): Effect.Effect<void> =>
    Effect.sync(() => {
      this.#policyExplicit = true;
      this.#policy = policy;
      if (this.#decisionNeeded && policy !== "ask") this.#settle(policy);
      else this.#publish();
    });

  hold = <A, E>(input: { readonly kind: OfflineActionKind; readonly text?: string; readonly clientMessageId?: string; readonly attachments?: import("./types").ChatSendInput["attachments"] }, run: () => Effect.Effect<A, E>): Effect.Effect<A, E | SpaceClientError> | null => {
    if (this.#connection.getSnapshot().state !== "reconnecting" && !this.#decisionNeeded) return null;
    const queuedSubject = this.#connection.getSnapshot().subject;
    const action: StoredOfflineAction = Object.freeze({ ...input, id: this.#connection.createId(), text: input.text ?? null, queuedAt: this.#connection.nowUnsafe() });
    return Effect.callback<void, SpaceClientError>((resume) => {
      if (this.#waiters.length === 0) this.#subject = queuedSubject;
      this.#notice = undefined;
      this.#waiters = [...this.#waiters, { action, resume }];
      this.#persist();
      this.#publish();
      return Effect.sync(() => this.#drop(action.id));
    }).pipe(Effect.andThen(Effect.suspend((): Effect.Effect<A, E | SpaceClientError> => (sameSubject(this.#connection.getSnapshot().subject, queuedSubject) ? run() : Effect.fail(discardedError())))));
  };

  dispose(): void {
    this.#unsubscribe();
    // Disposal can be a page teardown. Keep durable actions for the next instance.
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const waiter of waiters) waiter.resume(Effect.fail(discardedError()));
  }

  #connectionChanged(): void {
    const snapshot = this.#connection.getSnapshot();
    const state = snapshot.state;
    // A reload while offline can fail before fresh access arrives. Keep the queue for retry.
    const terminal = terminalConnection(snapshot);
    if (state === "live") this.#restore();
    if (this.#waiters.length === 0) {
      if (terminal) this.#discardSaved();
      return;
    }
    if (state === "live") {
      if (!this.#validScope()) {
        this.#notice = "Your offline actions were not sent because the Episode or participant changed.";
        this.#settle("discard");
        return;
      }
      if (this.#policy === "ask") {
        this.#decisionNeeded = true;
        this.#publish();
      } else this.#settle(this.#policy);
    } else if (terminal) {
      this.#notice = "Your offline actions were not sent because the Episode ended or the connection closed.";
      this.#settle("discard");
      this.#clearStorage();
    }
  }

  #settle(decision: "send" | "discard"): void {
    if (decision === "send" && this.#connection.getSnapshot().state !== "live") return;
    if (decision === "send" && !this.#validScope()) {
      this.#notice = "Your offline actions were not sent because the Episode or participant changed.";
      decision = "discard";
    }
    // Retire before dispatch: a crash after dispatch must never cause a replay.
    if (!this.#clearStorage() && this.#storage) {
      this.#notice = "Your offline actions could not be sent safely. Try again when storage is available.";
      this.#publish();
      return;
    }
    const waiters = this.#waiters;
    this.#waiters = [];
    this.#decisionNeeded = false;
    this.#publish();
    for (const waiter of waiters) this.#resumeWaiter(waiter, decision);
    this.#publish();
  }

  #drop(id: string): void {
    const next = this.#waiters.filter((waiter) => waiter.action.id !== id);
    if (next.length === this.#waiters.length) return;
    this.#waiters = next;
    this.#persist();
    if (next.length === 0) this.#decisionNeeded = false;
    this.#publish();
  }

  #validScope(): boolean {
    const current = this.#connection.getSnapshot().subject;
    const saved = this.#subject;
    return sameSubject(current, saved);
  }

  #clearStorage(): boolean {
    try {
      this.#storage?.removeItem(this.#storageKey);
      return true;
    } catch {
      return false;
    }
  }

  #persist(): void {
    if (!this.#storage || !this.#subject) return;
    try {
      if (this.#waiters.length === 0) this.#storage.removeItem(this.#storageKey);
      else this.#storage.setItem(this.#storageKey, JSON.stringify({ version: 1, subject: this.#subject, actions: this.#waiters.map(({ action }) => action) }));
    } catch {
      this.#notice = "Your offline actions are held, but could not be saved. Keep this page open.";
    }
  }

  #restore(): void {
    if (this.#restored || !this.#connection.getSnapshot().subject) return;
    this.#restored = true;
    if (this.#waiters.length > 0) return;
    const saved = this.#readStored();
    if (!saved) return;
    this.#subject = saved.subject;
    if (!this.#validScope()) {
      this.#notice = "Your offline actions were not sent because the Episode or participant changed.";
      this.#clearStorage();
      this.#publish();
      return;
    }
    const actions = saved.actions.filter((action) => this.#connection.nowUnsafe() - action.queuedAt < OFFLINE_ACTION_MAX_AGE_MS);
    if (actions.length !== saved.actions.length) this.#notice = "Your expired offline actions were not sent. Actions are kept for up to 24 hours.";
    if (!this.#policyExplicit) this.#policy = "ask";
    const restoredSubject = saved.subject;
    this.#waiters = actions.map((action) => ({
      action,
      resume: (permission) => {
        const command = this.#connection.runCommand(({ sync }) =>
          Effect.tryPromise({
            try: () => (action.kind === "chat_message" ? sync.sendChatMessage({ text: action.text ?? "", clientMessageId: action.clientMessageId ?? action.id, attachments: action.attachments ?? [] }).then(() => undefined) : sync.setHandRaised(action.kind === "hand_raise")),
            catch: () => discardedError(),
          }),
        );
        void Effect.runPromiseExit(
          permission.pipe(
            Effect.andThen(
              Effect.suspend(() => (sameSubject(this.#connection.getSnapshot().subject, restoredSubject) ? command : Effect.fail(discardedError()))).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    this.#notice = "An offline action was not sent. Please try it again.";
                    this.#publish();
                  }),
                ),
              ),
            ),
          ),
        );
      },
    }));
    this.#persist();
    this.#publish();
  }

  #resumeWaiter(waiter: Waiter, decision: "send" | "discard"): void {
    const expired = this.#connection.nowUnsafe() - waiter.action.queuedAt >= OFFLINE_ACTION_MAX_AGE_MS;
    if (expired) this.#notice = "Your expired offline actions were not sent. Actions are kept for up to 24 hours.";
    waiter.resume(decision === "send" && !expired ? Effect.void : Effect.fail(discardedError()));
  }

  #discardSaved(): void {
    try {
      if (!this.#storage?.getItem(this.#storageKey)) return;
      this.#notice = "Your offline actions were not sent because the Episode ended or the connection closed.";
      this.#clearStorage();
    } catch {
      this.#notice = "Saved offline actions could not be read. They will not be sent.";
    }
    this.#publish();
  }

  #readStored(): ReturnType<typeof decodeOfflineActions> | null {
    try {
      const raw = this.#storage?.getItem(this.#storageKey);
      if (!raw) return null;
      const saved = decodeOfflineActions(JSON.parse(raw));
      if (saved.actions.some((action) => !validStoredAction(action, this.#connection.nowUnsafe()))) throw new Error("Invalid offline action");
      return saved;
    } catch {
      this.#clearStorage();
      return null;
    }
  }

  #publish(): void {
    const slice: OfflineSlice = Object.freeze({ pending: Object.freeze(this.#waiters.map((waiter) => waiter.action)), decisionNeeded: this.#decisionNeeded, policy: this.#policy, ...(this.#notice ? { notice: this.#notice } : {}) });
    this.#store.updateOffline(slice);
  }
}
