import { Effect } from "effect";
import type { ConnectionLifecycleCapability, ConnectionPorts } from "../connection";
import { foreign, normalizeClientError, SpaceClientError, type ClientEffect } from "./errors";

export type FocusStepAwayReason = "reading" | "notes" | "break";
export type FocusControllerEffects = {
  readonly stepAway: (reason: FocusStepAwayReason) => ClientEffect<void>;
  readonly return: () => ClientEffect<void>;
  readonly allowOtherTabs: (minutes: number) => ClientEffect<void>;
  readonly endAllow: () => ClientEffect<void>;
  readonly dispose: () => void;
};
export const makeFocusController = (connection: ConnectionLifecycleCapability): Effect.Effect<FocusControllerEffects, never, import("effect").Scope.Scope> =>
  Effect.acquireRelease(
    Effect.sync(() => new FocusControllerRuntime(connection)),
    (controller) => Effect.sync(() => controller.dispose()),
  );
class FocusControllerRuntime implements FocusControllerEffects {
  readonly #connection: ConnectionLifecycleCapability;
  constructor(connection: ConnectionLifecycleCapability) {
    this.#connection = connection;
  }
  stepAway = (reason: FocusStepAwayReason): ClientEffect<void> =>
    this.#command(({ sync }) => {
      if (!["reading", "notes", "break"].includes(reason)) throw invalid("Step away must be reading, notes, or break");
      return foreign(() => sync.stepAway(reason));
    });
  return = (): ClientEffect<void> => this.#command(({ sync }) => foreign(() => sync.returnFromStepAway()));
  allowOtherTabs = (minutes: number): ClientEffect<void> =>
    this.#command(({ sync }) => {
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 240) throw invalid("Allow other tabs needs a whole number of minutes from 1 through 240");
      return foreign(() => sync.allowOtherTabs(minutes));
    });
  endAllow = (): ClientEffect<void> => this.#command(({ sync }) => foreign(() => sync.endAllowance()));
  dispose(): void {}
  #command(run: (ports: ConnectionPorts) => Effect.Effect<unknown, unknown>): ClientEffect<void> {
    return Effect.try({ try: () => run, catch: normalizeClientError }).pipe(
      Effect.flatMap((operation) => this.#connection.runCommand((ports) => operation(ports).pipe(Effect.asVoid))),
      Effect.mapError(normalizeClientError),
    );
  }
}
function invalid(message: string): SpaceClientError {
  return new SpaceClientError({ code: "participant.invalid", recoverable: false, message });
}
