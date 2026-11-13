import { arrivalRetryDelayMs, entranceStep, isTerminalArrivalError, readSpaceInviteToken, type ChalkPublicClient, type PublicSpaceArrival, type ReloadRejoinMarker } from "@q9labsai/chalk-client";
import { listedRememberedDevices } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { resumePublicSpace } from "../../lib/chalk-access";
import { reloadAfterChunkLoadFailure } from "../../lib/chunkReload";
import { arriveAtSpace, arrivalEvent, followArrivalLink, leaveArrival, reArrive, releaseAdmission } from "./arrival";
import { loadCallSurface, warmCall, type CallSurface } from "./call-surface";
import { canStart, entranceReducer, initialEntrance, pendingRelease, type ArrivalOutcome, type EndedCall, type Entrance, type EntranceEvent } from "./entrance-machine";
import { entryFailure, neutralSpaceError, resumeFailure } from "./entry-failure";
import type { Visitor, WebJoinSettings } from "./visitor";

/** Where the page enters: the Space's slug or invite code, and how the address bar moves to the Space's own link. */
export type SpaceRoute = {
  readonly slug: string | undefined;
  readonly inviteCode: string | undefined;
  readonly navigatePublicSpace: (canonicalSlug: string, inviteLink: string) => Promise<void>;
};

/** What every step of the entrance shares: the server, the state and its one way to change, and whether the page is still open. */
type EntranceDriver = {
  readonly client: ChalkPublicClient;
  /** Applies an event at once and says whether it changed anything, so a double click starts one arrival. */
  readonly send: (event: EntranceEvent) => boolean;
  readonly latest: RefObject<Entrance>;
  readonly active: RefObject<boolean>;
  /** Applies the outcome of arrival `attempt`. An admission the entrance no longer wants (a later arrival replaced it, or the page closed) is given back. */
  readonly settle: (attempt: number, outcome: ArrivalOutcome) => void;
};

/** The visitor's way from the Space link into the call, through the lobby, and back in after the call ends. */
export function useSpaceEntrance(client: ChalkPublicClient, route: SpaceRoute, visitor: Visitor) {
  const { reloadMarker, automaticName, rememberedDevices, displayName } = visitor;
  const { entrance, driver } = useEntranceDriver(client, () => initialEntrance({ resuming: Boolean(reloadMarker), stepOpen: !reloadMarker && !(automaticName && rememberedDevices) }));
  const [callName, setCallName] = useState<string>();
  useWarmCall(reloadMarker, entrance);
  useResume(driver, reloadMarker, route.slug);
  const start = useStart(driver, route, visitor, setCallName);
  useAutoArrival(visitor, start);
  const { inviteCode } = route;
  const again = useCallback((arrivalHandle: string) => reArrive(client, arrivalHandle, displayName, currentInviteToken(inviteCode)), [client, displayName, inviteCode]);
  useArrivalPoll(driver, entrance, again);
  const callSurface = useCallSurface(driver, entrance);
  const { send, latest, active } = driver;
  const cancel = useCallback(async () => {
    const left = latest.current;
    if (left.phase !== "waiting" || !send({ type: "cancelRequested" })) return;
    // An arrival the server already ended counts as cancelled.
    const failure = await leaveArrival(client, left.waiting.arrival).then(
      () => undefined,
      (cause: unknown) => (isTerminalArrivalError(cause) ? undefined : entryFailure(cause)),
    );
    if (!active.current) return;
    send(failure ? { type: "failed", attempt: left.attempt, failure } : { type: "cancelled", attempt: left.attempt });
  }, [active, client, latest, send]);
  const onEnded = useCallback(
    (call: EndedCall) => {
      if (!send({ type: "callEnded", call })) return;
      const { attempt } = latest.current;
      call.release().catch(() => send({ type: "failed", attempt, failure: { message: "Couldn’t leave the call. Try Home again.", retryable: true } }));
    },
    [latest, send],
  );
  const goHome = useCallback(
    (call: EndedCall, attempt: number) => {
      void call
        .release()
        .then(() => globalThis.location.assign("/"))
        .catch(() => send({ type: "failed", attempt, failure: { message: "Couldn’t leave the call. Try again.", retryable: true } }));
    },
    [send],
  );
  return { entrance, callName, callSurface, start, cancel, onEnded, goHome };
}

function currentInviteToken(inviteCode: string | undefined): string | undefined {
  return inviteCode ?? readSpaceInviteToken(globalThis.location?.hash ?? "");
}

function useEntranceDriver(client: ChalkPublicClient, initial: () => Entrance) {
  const [entrance, setEntrance] = useState(initial);
  const latest = useRef(entrance);
  const active = useRef(true);
  const send = useCallback((event: EntranceEvent): boolean => {
    const next = entranceReducer(latest.current, event);
    if (next === latest.current) return false;
    latest.current = next;
    setEntrance(next);
    return true;
  }, []);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const left = latest.current;
      // Once the call UI is ready, its own unmount releases the arrival.
      if (left.phase === "waiting") void leaveArrival(client, left.waiting.arrival).catch(() => undefined);
      if (left.phase === "admitted" && left.callUi === "loading") void left.joined.session.leave().catch(() => undefined);
      if (left.phase === "ended") void left.call.release().catch(() => undefined);
    };
  }, [client]);
  const settle = useCallback(
    (attempt: number, outcome: ArrivalOutcome) => {
      if (send({ ...outcome, attempt }) && active.current) return;
      releaseAdmission(outcome);
    },
    [send],
  );
  const driver = useMemo<EntranceDriver>(() => ({ client, send, latest, active, settle }), [client, send, settle]);
  return { entrance, driver };
}

function useWarmCall(reloadMarker: ReloadRejoinMarker | null, entrance: Entrance): void {
  useEffect(() => {
    if (!reloadMarker) warmCall();
  }, [reloadMarker]);
  // Sync closes the socket of a call that ended, so the next call's socket is warmed while the visitor reads the leave screen.
  const warmAfterCall = entrance.phase === "ended" && (entrance.call.phase === "left" || entrance.call.phase === "failed");
  useEffect(() => {
    if (warmAfterCall) warmCall();
  }, [warmAfterCall]);
}

/** Returns a reloaded visitor to the call the reload marker names. */
function useResume({ client, latest, settle }: EntranceDriver, reloadMarker: ReloadRejoinMarker | null, slug: string | undefined): void {
  const attempted = useRef(false);
  useEffect(() => {
    if (attempted.current || !reloadMarker) return;
    attempted.current = true;
    const { attempt } = latest.current;
    void loadCallSurface().catch(() => undefined);
    resumePublicSpace(client, reloadMarker, slug).then(
      (admission) => settle(attempt, { type: "admitted", joined: { ...admission, spaceName: admission.arrival.space?.name } }),
      (cause: unknown) => settle(attempt, { type: "failed", failure: resumeFailure(cause) }),
    );
  }, [client, latest, reloadMarker, settle, slug]);
}

/** Join, Ask again and Rejoin: a new arrival with these settings, once the previous call has been given back. */
function useStart({ client, send, latest, active, settle }: EntranceDriver, { slug, inviteCode, navigatePublicSpace }: SpaceRoute, { joinSettings, choose }: Visitor, setCallName: (name: string | undefined) => void) {
  return useCallback(
    (settings: WebJoinSettings = joinSettings, fromStep = false) => {
      const displayName = settings.displayName.trim();
      if (!displayName || !canStart(latest.current)) return;
      const previous = latest.current;
      const inviteToken = currentInviteToken(inviteCode);
      choose({ ...settings, displayName });
      if ((slug || inviteCode) && !inviteToken) {
        send({ type: "failed", attempt: previous.attempt, failure: { message: neutralSpaceError, retryable: false } });
        return;
      }
      send({ type: "started", fromStep });
      let { attempt } = latest.current;
      warmCall();
      void loadCallSurface().catch(() => undefined);
      /** Waits for the previous call's release, then returns the attempt the new arrival belongs to, or nothing when the entrance moved on meanwhile. */
      const released = async (): Promise<number | undefined> => {
        const release = pendingRelease(previous);
        if (!release) return attempt;
        await release();
        return active.current && send({ type: "rejoinReleased", attempt }) ? latest.current.attempt : undefined;
      };
      const enter = async () => {
        const current = await released();
        if (current === undefined) return;
        attempt = current;
        const arrived = await arriveAtSpace(client, { displayName, slug, inviteToken });
        await followArrivalLink(client, arrived, navigatePublicSpace);
        if (!active.current) {
          await leaveArrival(client, arrived.arrival);
          return;
        }
        setCallName(arrived.spaceName);
        settle(attempt, await arrivalEvent(client, arrived.arrival, arrived, (arrivalHandle) => reArrive(client, arrivalHandle, displayName, inviteToken)));
      };
      enter().catch((cause: unknown) => {
        if (active.current) send({ type: "failed", attempt, failure: entryFailure(cause) });
      });
    },
    [active, choose, client, inviteCode, joinSettings, latest, navigatePublicSpace, send, setCallName, settle, slug],
  );
}

/** A visitor with a known name and remembered devices joins without the device step. */
function useAutoArrival({ automaticName, rememberedDevices, reloadMarker }: Visitor, start: (settings: WebJoinSettings) => void): void {
  const attempted = useRef(false);
  useEffect(() => {
    if (!automaticName || !rememberedDevices || reloadMarker || attempted.current) return;
    attempted.current = true;
    void listedRememberedDevices(rememberedDevices).then((devices) => start({ ...devices, displayName: automaticName }));
  }, [automaticName, reloadMarker, rememberedDevices, start]);
}

/** Asks the server about a waiting arrival until the host answers. */
function useArrivalPoll({ client, settle }: EntranceDriver, entrance: Entrance, again: (arrivalHandle: string) => Promise<PublicSpaceArrival>): void {
  const waiting = entrance.phase === "waiting" && !entrance.cancelling ? entrance.waiting : undefined;
  const { attempt } = entrance;
  useEffect(() => {
    const arrivalHandle = waiting?.arrival.arrival_handle;
    if (!waiting || !arrivalHandle) return;
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      try {
        const answer = await client.status({ arrivalHandle });
        if (cancelled) return;
        if (entranceStep(answer).state === "pending") {
          timer = globalThis.setTimeout(poll, arrivalRetryDelayMs(answer.retry_after));
          return;
        }
        // Building the outcome can make another request, and a Cancel and a new Join may have happened meanwhile: the stamp then marks this answer as stale and settle gives it back.
        settle(attempt, await arrivalEvent(client, answer, { inviteLink: waiting.inviteLink ?? "", spaceName: waiting.spaceName }, again));
      } catch (cause) {
        if (!cancelled) settle(attempt, { type: "failed", failure: entryFailure(cause) });
      }
    };
    timer = globalThis.setTimeout(poll, arrivalRetryDelayMs(waiting.arrival.retry_after));
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [again, attempt, client, settle, waiting]);
}

/** Loads the call UI for an admission. When it can't load, the admission is given back and a stale bundle reloads the page. */
function useCallSurface({ send, active }: EntranceDriver, entrance: Entrance): CallSurface | null {
  const [callSurface, setCallSurface] = useState<CallSurface | null>(null);
  useEffect(() => {
    if (entrance.phase !== "admitted" || entrance.callUi === "ready") return;
    const { joined, attempt } = entrance;
    let cancelled = false;
    const failed = (cause: unknown) => {
      if (cancelled || !active.current) return;
      const release = () => joined.session.leave();
      send({ type: "callUiFailed", attempt, failure: entryFailure(cause), release });
      void release().then(
        () => reloadAfterChunkLoadFailure(cause),
        () => undefined,
      );
    };
    void loadCallSurface().then((surface) => {
      if (cancelled || !active.current) return;
      setCallSurface(surface);
      send({ type: "callUiReady", attempt });
    }, failed);
    return () => {
      cancelled = true;
    };
  }, [active, entrance, send]);
  return callSurface;
}
