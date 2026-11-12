import type { ClientFailure, PublicSpaceArrival, SessionExit } from "@q9labsai/chalk-client";
import type { PublicSpaceAdmission } from "../../lib/chalk-access";
import type { ReportProblem } from "../../lib/problem-reports";
import type { EntryFailure } from "./entry-failure";

/** A visitor the host has not let in yet. */
export type WaitingArrival = {
  readonly arrival: PublicSpaceArrival;
  readonly inviteLink: string | undefined;
  readonly spaceName: string | undefined;
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

/**
 * Where a visitor stands between opening a Space link and the call:
 * - `idle`: choosing a name and devices (`stepOpen`) or about to join without asking
 * - `arriving`: a request to the server is in flight
 * - `waiting`: let into the lobby, waiting for the host
 * - `admitted`: holds access; the call UI loads (`callUi: "loading"`), then takes over the arrival's release (`"ready"`)
 * - `ended`: the call is over; Rejoin starts a new arrival after releasing the old one
 * - `failed`: the entrance stopped with a message
 */
export type Entrance =
  | { readonly phase: "idle"; readonly stepOpen: boolean }
  | { readonly phase: "arriving"; readonly stepOpen: boolean }
  | { readonly phase: "waiting"; readonly waiting: WaitingArrival; readonly cancelling: boolean; readonly failure?: EntryFailure }
  | { readonly phase: "admitted"; readonly joined: JoinedSpace; readonly callUi: "loading" | "ready"; readonly stepOpen: boolean }
  | { readonly phase: "ended"; readonly call: EndedCall; readonly rejoining: boolean; readonly failure?: EntryFailure }
  | { readonly phase: "failed"; readonly failure: EntryFailure };

export type EntranceEvent =
  | { readonly type: "started"; readonly fromStep: boolean }
  | { readonly type: "rejoinReleased" }
  | { readonly type: "waitingForHost"; readonly waiting: WaitingArrival }
  | { readonly type: "admitted"; readonly joined: JoinedSpace }
  | { readonly type: "callUiReady" }
  | { readonly type: "failed"; readonly failure: EntryFailure }
  | { readonly type: "cancelRequested" }
  | { readonly type: "cancelled" }
  | { readonly type: "callEnded"; readonly call: EndedCall };

export function initialEntrance(options: { readonly resuming: boolean; readonly stepOpen: boolean }): Entrance {
  return options.resuming ? { phase: "arriving", stepOpen: false } : { phase: "idle", stepOpen: options.stepOpen };
}

/** Whether Join, Ask again or Rejoin can start a new arrival now. */
export function canStart(entrance: Entrance): boolean {
  return entrance.phase === "idle" || entrance.phase === "failed" || (entrance.phase === "ended" && !entrance.rejoining);
}

export function entranceReducer(entrance: Entrance, event: EntranceEvent): Entrance {
  switch (event.type) {
    case "started":
      if (entrance.phase === "ended" && !entrance.rejoining) return { phase: "ended", call: entrance.call, rejoining: true };
      return canStart(entrance) ? { phase: "arriving", stepOpen: event.fromStep } : entrance;
    case "rejoinReleased":
      return entrance.phase === "ended" && entrance.rejoining ? { phase: "arriving", stepOpen: false } : entrance;
    case "waitingForHost":
      return entrance.phase === "arriving" ? { phase: "waiting", waiting: event.waiting, cancelling: false } : entrance;
    case "admitted":
      if (entrance.phase === "arriving") return { phase: "admitted", joined: event.joined, callUi: "loading", stepOpen: entrance.stepOpen };
      return entrance.phase === "waiting" && !entrance.cancelling ? { phase: "admitted", joined: event.joined, callUi: "loading", stepOpen: false } : entrance;
    case "callUiReady":
      return entrance.phase === "admitted" ? { ...entrance, callUi: "ready" } : entrance;
    case "failed":
      if (entrance.phase === "ended") return { phase: "ended", call: entrance.call, rejoining: false, failure: event.failure };
      if (entrance.phase === "waiting" && entrance.cancelling) return { ...entrance, cancelling: false, failure: event.failure };
      return { phase: "failed", failure: event.failure };
    case "cancelRequested":
      return entrance.phase === "waiting" && !entrance.cancelling ? { phase: "waiting", waiting: entrance.waiting, cancelling: true } : entrance;
    case "cancelled":
      return entrance.phase === "waiting" && entrance.cancelling ? { phase: "idle", stepOpen: true } : entrance;
    case "callEnded":
      return entrance.phase === "admitted" ? { phase: "ended", call: event.call, rejoining: false } : entrance;
  }
}
