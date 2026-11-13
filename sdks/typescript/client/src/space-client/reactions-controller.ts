import { CHALK_REACTIONS } from "../collaboration/types";
import { Clock, Effect, Scope } from "effect";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { makeScopedFork, type ScopedFork } from "./scoped-fork";
import { foreign, normalizeClientError, SpaceClientError, type ClientEffect } from "./errors";
import { SpaceStore } from "./store";
import type { ActiveReaction, Reaction } from "./types";
const MAX_VISIBLE_REACTIONS = 24;
const REACTIONS = new Set<Reaction>(CHALK_REACTIONS);
export type ReactionsControllerEffects = {
  readonly send: (emoji: Reaction) => ClientEffect<ActiveReaction>;
  readonly dispose: () => void;
};
/** Reaction expiry fibers are owned by the active client Scope. */
export const makeReactionsController = (connection: ConnectionLifecycleCapability, store: SpaceStore): Effect.Effect<ReactionsControllerEffects, never, Clock.Clock | Scope.Scope> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const fork = yield* makeScopedFork<Clock.Clock>();
    const controller = new ReactionsControllerRuntime(connection, store, clock.currentTimeMillisUnsafe, fork);
    yield* Effect.addFinalizer(() => Effect.sync(() => controller.dispose()));
    return controller;
  });
class ReactionsControllerRuntime implements ReactionsControllerEffects {
  readonly #connection: ConnectionLifecycleCapability;
  readonly #store: SpaceStore;
  readonly #now: () => number;
  readonly #fork: ScopedFork<Clock.Clock>;
  readonly #active = new Map<string, ActiveReaction>();
  readonly #expiryGenerations = new Map<string, number>();
  #unsubscribePorts: (() => void) | null = null;
  #unsubscribe: (() => void) | null = null;
  constructor(connection: ConnectionLifecycleCapability, store: SpaceStore, now: () => number, fork: ScopedFork<Clock.Clock>) {
    this.#connection = connection;
    this.#store = store;
    this.#now = now;
    this.#fork = fork;
    this.#unsubscribePorts = connection.subscribePorts((ports) => this.#bind(ports));
  }
  send = (emoji: Reaction): ClientEffect<ActiveReaction> => {
    return Effect.try({
      try: () => {
        if (!REACTIONS.has(emoji)) throw new SpaceClientError({ code: "reaction.invalid", recoverable: false, message: "The reaction is not supported" });
      },
      catch: normalizeClientError,
    }).pipe(
      Effect.andThen(this.#connection.runCommand(({ sync }) => foreign(() => sync.sendReaction(emoji)))),
      Effect.map(reactionFor),
      Effect.tap((reaction) =>
        Effect.sync(() => {
          this.#observe(reaction);
        }),
      ),
      Effect.mapError(normalizeClientError),
    );
  };
  dispose(): void {
    this.#unsubscribePorts?.();
    this.#unsubscribe?.();
    this.#unsubscribePorts = null;
    this.#unsubscribe = null;
    this.#clear();
  }
  #bind(ports: ConnectionPorts | null): void {
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (!ports) {
      this.#clear();
      return;
    }
    this.#unsubscribe = ports.sync.subscribeCollaboration((event) => {
      if (event.type === "reaction") this.#observe(reactionFor(event.reaction));
    });
  }
  #observe(reaction: ActiveReaction): void {
    const expiresAt = Date.parse(reaction.expiresAt);
    if (!validReaction(reaction) || !Number.isFinite(expiresAt) || this.#active.has(reaction.eventId)) return;
    this.#active.set(reaction.eventId, reaction);
    while (this.#active.size > MAX_VISIBLE_REACTIONS) this.#remove(this.#active.keys().next().value!);
    const generation = (this.#expiryGenerations.get(reaction.eventId) ?? 0) + 1;
    this.#expiryGenerations.set(reaction.eventId, generation);
    const delay = Math.max(0, expiresAt - this.#now());
    this.#fork(
      Effect.sleep(delay).pipe(
        Effect.andThen(
          Effect.sync(() => {
            if (this.#expiryGenerations.get(reaction.eventId) === generation) this.#remove(reaction.eventId);
          }),
        ),
      ),
    );
    this.#publish();
  }
  #remove(eventId: string): void {
    this.#expiryGenerations.delete(eventId);
    if (!this.#active.delete(eventId)) return;
    this.#publish();
  }
  #clear(): void {
    this.#expiryGenerations.clear();
    if (this.#active.size === 0) return;
    this.#active.clear();
    this.#publish();
  }
  #publish(): void {
    const active = Object.freeze([...this.#active.values()]);
    const current = this.#store.getSnapshot().reactions.active;
    if (sameReactions(current, active)) return;
    this.#store.update("reactions", Object.freeze({ active }));
  }
}
function reactionFor(reaction: import("../collaboration/types").ChalkReactionEvent): ActiveReaction {
  return Object.freeze({ ...reaction });
}
function validReaction(reaction: ActiveReaction): boolean {
  return reaction.eventId.length > 0 && reaction.participantId.length > 0 && reaction.displayName.length > 0 && REACTIONS.has(reaction.reaction) && Number.isFinite(Date.parse(reaction.occurredAt));
}
function sameReactions(left: readonly ActiveReaction[], right: readonly ActiveReaction[]): boolean {
  return (
    left.length === right.length &&
    left.every((reaction, index) => {
      const candidate = right[index]!;
      return reaction.eventId === candidate.eventId && reaction.participantId === candidate.participantId && reaction.displayName === candidate.displayName && reaction.reaction === candidate.reaction && reaction.occurredAt === candidate.occurredAt && reaction.expiresAt === candidate.expiresAt;
    })
  );
}
