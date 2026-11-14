import type { ClientFailure, PublicSpaceArrival, SessionExit } from "@q9labsai/chalk-client";
import type { PublicSpaceAdmission } from "../../lib/chalk-access";
import type { ReportProblem } from "../../lib/problem-reports";
import type { EntryFailure } from "./entry-failure";

/** A visitor the host has not let in yet. */
export type WaitingArrival = {
  readonly arrival: PublicSpaceArrival;
  readonly inviteLink?: string | undefined;
  readonly spaceName?: string | undefined;
};

/** An admitted visitor: the access they hold and the Space it opens. */
export type JoinedSpace = PublicSpaceAdmission & {
  readonly inviteLink?: string | undefined;
  readonly spaceName?: string | undefined;
};

export type ExitPhase = "left" | SessionExit;

/** What the leave screen shows once a call is over. `release` gives the arrival back and can be called again after it fails. */
export type EndedCall = {
  readonly phase: ExitPhase;
  readonly endReason?: string;
  readonly hostCanExtend: boolean;
  readonly tenantId: string | undefined;
  readonly callName: string | undefined;
  readonly failure: ClientFailure | null | undefined;
  readonly release: () => Promise<void>;
  readonly reportProblem?: ReportProblem;
  readonly reportExpiresAt?: number;
};

/** Gives an arrival back to the server. Calls that overlap share one request, and a failed one can be tried again. */
export type Release = () => Promise<void>;

/**
 * Where a visitor stands between opening a Space link and the call. Every phase carries the `attempt` it belongs to: each
 * new arrival is the next number, and an event stamped with any other number is a late answer from an arrival that is gone, so it changes nothing.
 * - `idle`: choosing a name and devices (`stepOpen`) or about to join without asking
 * - `arriving`: a request to the server is in flight
 * - `waiting`: let into the lobby, waiting for the host
 * - `admitted`: holds access; the call UI loads (`callUi: "loading"`), then takes over the arrival's release (`"ready"`)
 * - `ended`: the call is over; Rejoin starts a new arrival after releasing the old one
 * - `failed`: the entrance stopped with a message. When it still `held` an admission, that release may be running, and a new arrival waits for it (`restarting`)
 */
export type Entrance =
  | { readonly phase: "idle"; readonly attempt: number; readonly stepOpen: boolean }
  | { readonly phase: "arriving"; readonly attempt: number; readonly stepOpen: boolean }
  | { readonly phase: "waiting"; readonly attempt: number; readonly waiting: WaitingArrival; readonly cancelling: boolean; readonly failure?: EntryFailure }
  | { readonly phase: "admitted"; readonly attempt: number; readonly joined: JoinedSpace; readonly callUi: "loading" | "ready"; readonly stepOpen: boolean }
  | { readonly phase: "ended"; readonly attempt: number; readonly call: EndedCall; readonly rejoining: boolean; readonly failure?: EntryFailure }
  | { readonly phase: "failed"; readonly attempt: number; readonly failure: EntryFailure; readonly held?: Release; readonly restarting: boolean };

/** What an arrival's request found out, before it is stamped with the attempt that asked. */
export type ArrivalOutcome = { readonly type: "waitingForHost"; readonly waiting: WaitingArrival } | { readonly type: "admitted"; readonly joined: JoinedSpace } | { readonly type: "failed"; readonly failure: EntryFailure };

export type EntranceEvent =
  | { readonly type: "started"; readonly fromStep: boolean }
  | { readonly type: "rejoinReleased"; readonly attempt: number }
  | (ArrivalOutcome & { readonly attempt: number })
  | { readonly type: "callUiReady"; readonly attempt: number }
  | { readonly type: "callUiFailed"; readonly attempt: number; readonly failure: EntryFailure; readonly release: Release }
  | { readonly type: "cancelRequested" }
  | { readonly type: "cancelled"; readonly attempt: number }
  | { readonly type: "callEnded"; readonly call: EndedCall };

export function initialEntrance(options: { readonly resuming: boolean; readonly stepOpen: boolean }): Entrance {
  return options.resuming ? { phase: "arriving", attempt: 1, stepOpen: false } : { phase: "idle", attempt: 0, stepOpen: options.stepOpen };
}

/** What a new arrival must wait for: the old call or admission still being given back. */
export function pendingRelease(entrance: Entrance): Release | undefined {
  if (entrance.phase === "ended") return entrance.call.release;
  return entrance.phase === "failed" ? entrance.held : undefined;
}

/** Whether Join, Ask again or Rejoin can start now. */
export function canStart(entrance: Entrance): boolean {
  switch (entrance.phase) {
    case "idle":
      return true;
    case "failed":
      return !entrance.restarting;
    case "ended":
      return !entrance.rejoining;
    default:
      return false;
  }
}

export function entranceReducer(entrance: Entrance, event: EntranceEvent): Entrance {
  if ("attempt" in event && event.attempt !== entrance.attempt) return entrance;
  switch (event.type) {
    case "started":
      if (!canStart(entrance)) return entrance;
      if (entrance.phase === "ended") return { ...entrance, rejoining: true };
      if (entrance.phase === "failed" && entrance.held) return { ...entrance, restarting: true };
      return { phase: "arriving", attempt: entrance.attempt + 1, stepOpen: event.fromStep };
    case "rejoinReleased":
      return (entrance.phase === "ended" && entrance.rejoining) || (entrance.phase === "failed" && entrance.restarting) ? { phase: "arriving", attempt: entrance.attempt + 1, stepOpen: false } : entrance;
    case "waitingForHost":
      return entrance.phase === "arriving" ? { phase: "waiting", attempt: entrance.attempt, waiting: event.waiting, cancelling: false } : entrance;
    case "admitted":
      if (entrance.phase === "arriving") return { phase: "admitted", attempt: entrance.attempt, joined: event.joined, callUi: "loading", stepOpen: entrance.stepOpen };
      return entrance.phase === "waiting" && !entrance.cancelling ? { phase: "admitted", attempt: entrance.attempt, joined: event.joined, callUi: "loading", stepOpen: false } : entrance;
    case "callUiReady":
      return entrance.phase === "admitted" ? { ...entrance, callUi: "ready" } : entrance;
    case "callUiFailed":
      return entrance.phase === "admitted" ? { phase: "failed", attempt: entrance.attempt, failure: event.failure, held: event.release, restarting: false } : entrance;
    case "failed":
      if (entrance.phase === "ended") return { ...entrance, rejoining: false, failure: event.failure };
      if (entrance.phase === "waiting" && entrance.cancelling) return { ...entrance, cancelling: false, failure: event.failure };
      if (entrance.phase === "failed") return { ...entrance, failure: event.failure, restarting: false };
      return { phase: "failed", attempt: entrance.attempt, failure: event.failure, restarting: false };
    case "cancelRequested":
      return entrance.phase === "waiting" && !entrance.cancelling ? { ...entrance, cancelling: true } : entrance;
    case "cancelled":
      return entrance.phase === "waiting" && entrance.cancelling ? { phase: "idle", attempt: entrance.attempt, stepOpen: true } : entrance;
    case "callEnded":
      return entrance.phase === "admitted" ? { phase: "ended", attempt: entrance.attempt, call: event.call, rejoining: false } : entrance;
  }
}
