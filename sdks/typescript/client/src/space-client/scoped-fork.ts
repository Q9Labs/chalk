import { Effect, type Scope } from "effect";

export type ScopedFork<R = never> = (effect: Effect.Effect<void, unknown, R>) => void;

/** Fire-and-forget fibers owned by the active controller Scope: closing the Scope interrupts them. */
export const makeScopedFork = <R = never>(): Effect.Effect<ScopedFork<R>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const context = yield* Effect.context<R>();
    return (effect) => {
      void Effect.runForkWith(context)(Effect.forkIn(effect, scope).pipe(Effect.asVoid));
    };
  });
