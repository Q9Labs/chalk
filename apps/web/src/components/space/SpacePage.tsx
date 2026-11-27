import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { browserAllowsAutomaticEntry } from "./browser-autoplay";
import { entranceAutoplayDecision } from "./entrance-autoplay";
import { useTheme } from "../../lib/theme-context";
import { arrivalRetryDelayMs, entranceStep, isTerminalArrivalError, preconnect, readReloadRejoin, readSpaceInviteToken, type JoinOptions } from "@q9labsai/chalk-client";
import { CallLimbo, listedRememberedDevices, readRememberedDevices, type PreJoinJoinOptions } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { publicAPIBaseURL, publicSyncDirectURL, publicSyncURL, createPublicInviteClient, resumePublicSpace } from "../../lib/chalk-access";
import { getAccount } from "../../lib/account-api";
import { reloadAfterChunkLoadFailure } from "../../lib/chunkReload";
import type * as CallSurface from "./SpaceCall";
import { PreJoin } from "./pre-join/PreJoin";
import type { ReportProblem } from "../../lib/send-problem-report";
import { arriveAtSpace, arrivalEvent, leaveArrival, reArrive, resumeReloadOutcome } from "./arrival";
import { canStart, entranceReducer, initialEntrance, pendingRelease, type ArrivalOutcome, type EndedCall, type Entrance, type EntranceEvent } from "./entrance-machine";
import { entryFailure, neutralSpaceError, resumeFailure } from "./entry-failure";
import { FailedEntry } from "./FailedEntry";
type WebJoinSettings = Required<Pick<JoinOptions, "displayName" | "microphone" | "camera">> & Pick<JoinOptions, "microphoneDeviceId" | "cameraDeviceId" | "speakerDeviceId">;
const displayNameStorageKey = "chalk.display-name";
const devicesOff = { microphone: false, camera: false };
// A visitor on the lobby or the leave screen usually presses Join within seconds. Sync closes an idle socket after 5 s, so the
// SDK replaces it for this long after the last action: about four short-lived sockets at most, then none.
const LOBBY_KEEP_WARM_MS = 15_000;
/**
 * Opens the API connection and the Sync WebSocket upgrade before Join, so joining skips both. The call UI stays unloaded
 * until Join: the call-performance route budget guards that. Call this again as the visitor acts to extend the window.
 */
function warmCall(): void {
  const apiBaseURL = publicAPIBaseURL();
  preconnect({ baseUrl: apiBaseURL, syncUrl: publicSyncURL(apiBaseURL), syncDirectUrl: publicSyncDirectURL().syncDirectURL, keepWarmMs: LOBBY_KEEP_WARM_MS });
}
let callSurfaceLoad: Promise<typeof CallSurface> | undefined;
/** Loads the call UI and media stack, which a participant needs only once they ask to join. */
function loadCallSurface(): Promise<typeof CallSurface> {
  callSurfaceLoad ??= import("./SpaceCall").catch((cause: unknown) => {
    callSurfaceLoad = undefined;
    throw cause;
  });
  return callSurfaceLoad;
}
type SpacePageProps = {
  readonly slug?: string;
  readonly inviteCode?: string;
  readonly navigatePublicSpace?: (canonicalSlug: string, inviteLink: string) => Promise<void>;
};
export function SpacePage(props: SpacePageProps = {}) {
  const { mode } = useTheme();
  return (
    <div data-chalk data-chalk-theme={mode} className="flex h-dvh min-h-0 w-full flex-col overflow-hidden">
      <div className="mx-auto w-full max-w-5xl shrink-0 px-4">
        <PrivacyNotice overCall />
      </div>
      <div className="relative min-h-0 flex-1">
        <SpaceEntry {...props} />
      </div>
    </div>
  );
}
function SpaceEntry({ slug, inviteCode, navigatePublicSpace = replacePublicSpaceHistory }: SpacePageProps) {
  const { mode } = useTheme();
  const client = useMemo(() => createPublicInviteClient(), []);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportDialog, setReportDialog] = useState<{ send: ReportProblem; diagnostics: string } | null>(null);
  const reportFocusScope = useRef<HTMLDivElement>(null);
  const [reloadMarker] = useState(() => {
    const routeKey = slug ?? inviteCode;
    if (!routeKey) return null;
    try {
      const marker = readReloadRejoin(globalThis.sessionStorage, routeKey);
      return marker?.arrivalHandle ? marker : null;
    } catch {
      return null; // Storage may be disabled; manual entry remains available.
    }
  });
  const [automaticName, setAutomaticName] = useState(() => {
    const queryName = new URLSearchParams(globalThis.location?.search ?? "").get("name")?.trim();
    if (queryName) return queryName;
    try {
      return globalThis.localStorage.getItem(displayNameStorageKey)?.trim() ?? "";
    } catch {
      return "";
    }
  });
  // A visitor who already chose devices in this browser skips the device step and joins with that choice.
  const [rememberedDevices] = useState(() => readRememberedDevices());
  const [automaticEntry] = useState(browserAllowsAutomaticEntry);
  const autoplayEntry = entranceAutoplayDecision({ automaticEntry, reloadMarker: Boolean(reloadMarker), automaticName, rememberedDevices: Boolean(rememberedDevices && rememberedDevices.inputsChosen !== false) });
  const resumeAutomatically = autoplayEntry === "resume";
  const rememberedAutoArrival = autoplayEntry === "arrive";
  const { entrance, send, latest } = useEntrance(() => initialEntrance({ resuming: resumeAutomatically, stepOpen: !resumeAutomatically && !rememberedAutoArrival }));
  const [displayName, setDisplayName] = useState(reloadMarker?.displayName ?? automaticName);
  const [entranceSettings, setEntranceSettings] = useState<WebJoinSettings | null>(reloadMarker ? { displayName: reloadMarker.displayName, ...devicesOff } : null);
  const [callName, setCallName] = useState<string>();
  const autoArrivalAttempted = useRef(false);
  const resumeAttempted = useRef(false);
  const nameEdited = useRef(false);
  const [callSurface, setCallSurface] = useState<typeof CallSurface | null>(null);
  const session = entrance.phase === "admitted" ? entrance.joined.session : undefined;
  const ended = entrance.phase === "ended" ? entrance.call : undefined;
  const active = useRef(true);
  const defaultJoinOptions = useMemo<WebJoinSettings>(() => ({ ...(entranceSettings ?? devicesOff), displayName }), [displayName, entranceSettings]);
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
  }, [client, latest]);
  /** Applies the outcome of arrival `attempt`. An admission the entrance no longer wants (a later arrival replaced it, or the page closed) is given back. */
  const settle = useCallback(
    (attempt: number, outcome: ArrivalOutcome) => {
      if (send({ ...outcome, attempt }) && active.current) return;
      releaseAdmission(outcome);
    },
    [send],
  );
  useEffect(() => {
    if (!reloadMarker) warmCall();
  }, [reloadMarker]);
  // Sync closes the socket of a call that ended, so the next call's socket is warmed while the visitor reads the leave screen.
  const warmAfterCall = ended?.phase === "left" || ended?.phase === "failed";
  useEffect(() => {
    if (warmAfterCall) warmCall();
  }, [warmAfterCall]);
  useEffect(() => {
    if (resumeAttempted.current || !reloadMarker || !resumeAutomatically) return;
    resumeAttempted.current = true;
    const { attempt } = latest.current;
    setDisplayName(reloadMarker.displayName);
    setEntranceSettings({ displayName: reloadMarker.displayName, ...devicesOff });
    void loadCallSurface().catch(() => undefined);
    resumePublicSpace(client, reloadMarker, slug).then(
      (admission) => settle(attempt, { type: "admitted", joined: { ...admission, spaceName: admission.arrival.space?.name } }),
      (cause: unknown) => settle(attempt, { type: "failed", failure: resumeFailure(cause) }),
    );
  }, [client, latest, reloadMarker, resumeAutomatically, settle, slug]);
  const start = useCallback(
    (settings: WebJoinSettings = defaultJoinOptions, fromStep = false) => {
      const normalizedDisplayName = settings.displayName.trim();
      const inviteToken = inviteCode ?? readSpaceInviteToken(globalThis.location?.hash ?? "");
      if (!normalizedDisplayName || !canStart(latest.current)) return;
      const previous = latest.current;
      setDisplayName(normalizedDisplayName);
      setEntranceSettings({ ...settings, displayName: normalizedDisplayName });
      try {
        globalThis.localStorage.setItem(displayNameStorageKey, normalizedDisplayName);
      } catch {
        /* Joining works with storage disabled. */
      }
      if ((slug || inviteCode) && !inviteToken) {
        send({ type: "failed", attempt: previous.attempt, failure: { message: neutralSpaceError, retryable: false } });
        return;
      }
      const reloadResumeMarker = reloadMarker && !resumeAttempted.current ? reloadMarker : undefined;
      if (reloadResumeMarker) resumeAttempted.current = true;
      send({ type: "started", fromStep });
      let { attempt } = latest.current;
      warmCall();
      void loadCallSurface().catch(() => undefined);
      void (async () => {
        const release = pendingRelease(previous);
        if (release) {
          await release();
          if (!active.current || !send({ type: "rejoinReleased", attempt })) return;
          attempt = latest.current.attempt;
        }
        if (reloadResumeMarker) return settle(attempt, await resumeReloadOutcome(client, reloadResumeMarker, slug));
        const arrived = await arriveAtSpace(client, { displayName: normalizedDisplayName, slug, inviteToken });
        try {
          await navigatePublicSpace(arrived.canonicalSlug, arrived.inviteLink);
        } catch (cause) {
          await leaveArrival(client, arrived.arrival);
          throw cause;
        }
        if (!active.current) {
          await leaveArrival(client, arrived.arrival);
          return;
        }
        setCallName(arrived.spaceName);
        settle(attempt, await arrivalEvent(client, arrived.arrival, arrived, (arrivalHandle) => reArrive(client, arrivalHandle, normalizedDisplayName, inviteToken)));
      })().catch((cause: unknown) => {
        if (active.current) send({ type: "failed", attempt, failure: reloadResumeMarker ? resumeFailure(cause) : entryFailure(cause) });
      });
    },
    [client, defaultJoinOptions, inviteCode, latest, navigatePublicSpace, reloadMarker, send, settle, slug],
  );
  useEffect(() => {
    if (automaticName || reloadMarker) return;
    let cancelled = false;
    void getAccount()
      .then((account) => {
        if (!cancelled && !nameEdited.current && account.name.trim()) {
          setDisplayName((current) => current || account.name);
          setAutomaticName(account.name);
        }
      })
      .catch(() => undefined); // Anonymous visitors supply their own name.
    return () => {
      cancelled = true;
    };
  }, [automaticName, reloadMarker]);
  useEffect(() => {
    if (!rememberedAutoArrival || !rememberedDevices || autoArrivalAttempted.current) return;
    autoArrivalAttempted.current = true;
    void listedRememberedDevices(rememberedDevices).then((devices) => start({ ...devices, displayName: automaticName }));
  }, [automaticName, rememberedAutoArrival, rememberedDevices, start]);
  const waiting = entrance.phase === "waiting" && !entrance.cancelling ? entrance.waiting : undefined;
  const waitingAttempt = entrance.attempt;
  useEffect(() => {
    const arrival = waiting?.arrival;
    const arrivalHandle = arrival?.arrival_handle;
    if (!waiting || !arrival || !arrivalHandle) return;
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
        settle(waitingAttempt, await arrivalEvent(client, answer, { inviteLink: waiting.inviteLink ?? "", spaceName: waiting.spaceName }, (handle) => reArrive(client, handle, displayName, inviteCode ?? readSpaceInviteToken(globalThis.location?.hash ?? ""))));
      } catch (cause) {
        if (!cancelled) settle(waitingAttempt, { type: "failed", failure: entryFailure(cause) });
      }
    };
    timer = globalThis.setTimeout(poll, arrivalRetryDelayMs(arrival.retry_after));
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [client, displayName, inviteCode, settle, waiting, waitingAttempt]);
  const cancel = useCallback(async () => {
    const left = latest.current;
    if (left.phase !== "waiting" || !send({ type: "cancelRequested" })) return;
    try {
      await leaveArrival(client, left.waiting.arrival);
    } catch (cause) {
      if (!isTerminalArrivalError(cause)) {
        if (active.current) send({ type: "failed", attempt: left.attempt, failure: entryFailure(cause) });
        return;
      }
    }
    if (active.current) send({ type: "cancelled", attempt: left.attempt });
  }, [client, latest, send]);
  useEffect(() => {
    if (entrance.phase !== "admitted" || entrance.callUi === "ready") return;
    const { joined, attempt } = entrance;
    let cancelled = false;
    void loadCallSurface().then(
      (surface) => {
        if (cancelled || !active.current) return;
        setCallSurface(surface);
        send({ type: "callUiReady", attempt });
      },
      (cause: unknown) => {
        if (cancelled || !active.current) return;
        const release = () => joined.session.leave();
        send({ type: "callUiFailed", attempt, failure: entryFailure(cause), release });
        void release().then(
          () => reloadAfterChunkLoadFailure(cause),
          () => undefined,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [entrance, send]);
  const onEnded = useCallback(
    (call: EndedCall) => {
      if (!send({ type: "callEnded", call })) return;
      const { attempt } = latest.current;
      call.release().catch(() => send({ type: "failed", attempt, failure: { message: "Couldn’t leave the call. Try Home again.", retryable: true } }));
    },
    [latest, send],
  );
  const settings = entranceSettings ?? defaultJoinOptions;
  const renderSurface = () => {
    if (entrance.phase === "ended" && callSurface) {
      const { call, rejoining, failure, attempt } = entrance;
      const { EndedStatusSurface } = callSurface;
      return (
        <main className="relative h-full">
          <EndedStatusSurface
            call={call}
            endAction={call.offerSignUp ? { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") } : undefined}
            theme={{ colorScheme: mode }}
            onOpenReportProblem={() => setReportOpen(true)}
            rejoinDisabled={rejoining}
            onRejoin={() => start(settings)}
            onHome={() => {
              void call
                .release()
                .then(() => globalThis.location.assign("/"))
                .catch(() => send({ type: "failed", attempt, failure: { message: "Couldn’t leave the call. Try again.", retryable: true } }));
            }}
          />
          {failure ? (
            <p role="alert" className="absolute inset-x-6 bottom-6 text-center text-sm">
              {failure.message}
            </p>
          ) : null}
        </main>
      );
    }
    if (entrance.phase === "admitted" && entrance.callUi === "ready" && callSurface) {
      const { LocalSpace } = callSurface;
      return (
        <LocalSpace
          admission={entrance.joined}
          onOpenReportProblem={(send, diagnostics) => {
            setReportDialog({ send, diagnostics });
            setReportOpen(true);
          }}
          displayName={settings.displayName}
          defaults={settings}
          spaceName={entrance.joined.spaceName}
          inviteLink={entrance.joined.inviteLink}
          onEnded={onEnded}
        />
      );
    }
    return (
      <main data-chalk data-chalk-theme={mode} className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="min-h-0 flex-1">{renderEntrance(entrance)}</div>
      </main>
    );
  };
  const renderEntrance = (current: Entrance) => {
    switch (current.phase) {
      case "waiting":
        return (
          <CallLimbo
            theme={{ colorScheme: mode }}
            spaceName={current.waiting.spaceName}
            message={current.failure?.message ?? `Asking to join ${current.waiting.spaceName ?? "the call"}`}
            detail={current.failure ? undefined : "The host will let you in."}
            joiningAs={current.failure ? undefined : displayName.trim()}
            action={{ label: "Cancel", onClick: () => void cancel(), disabled: current.cancelling }}
          />
        );
      case "failed":
        return <FailedEntry failure={current.failure} spaceName={callName} colorScheme={mode} restarting={current.restarting} onAskAgain={() => start()} />;
      case "idle":
      case "arriving":
      case "admitted":
        return current.stepOpen ? (
          <PreJoin
            spaceName={callName}
            displayName={displayName}
            onDisplayNameChange={(name) => {
              nameEdited.current = true;
              setDisplayName(name);
              warmCall();
            }}
            joining={current.phase !== "idle"}
            rejoin={Boolean(reloadMarker)}
            onJoin={(devices: PreJoinJoinOptions) => start({ ...devices, displayName }, true)}
          />
        ) : (
          <CallLimbo theme={{ colorScheme: mode }} spaceName={callName} message={`Joining ${callName ?? "the call"}…`} />
        );
      case "ended":
        return <CallLimbo theme={{ colorScheme: mode }} spaceName={callName} message={`Joining ${callName ?? "the call"}…`} />;
    }
  };
  const sendReport = ended?.reportProblem ?? reportDialog?.send;
  return (
    <div ref={reportFocusScope} className="contents">
      {renderSurface()}
      {sendReport && callSurface ? (
        <callSurface.SpaceReportProblemDialog
          tenantId={ended?.tenantId ?? session?.reloadMarker().tenantId}
          reportExpiresAt={ended?.reportExpiresAt}
          reportSession={session}
          reportKey={ended?.reportKey}
          diagnostics={ended ? callSurface.reportDiagnostics(ended.callName ?? "Call", { status: ended.phase, lastError: ended.failure }) : (reportDialog?.diagnostics ?? "")}
          focusScope={reportFocusScope}
          open={reportOpen}
          onClose={() => setReportOpen(false)}
          onReportProblem={sendReport}
          colorScheme={mode}
        />
      ) : null}
    </div>
  );
}

/** The entrance's state and its one way to change it. `send` applies an event at once and says whether it changed anything, so a double click starts one arrival. */
function useEntrance(initial: () => Entrance) {
  const [entrance, setEntrance] = useState(initial);
  const latest = useRef(entrance);
  const send = useCallback((event: EntranceEvent): boolean => {
    const next = entranceReducer(latest.current, event);
    if (next === latest.current) return false;
    latest.current = next;
    setEntrance(next);
    return true;
  }, []);
  return { entrance, send, latest };
}

/** Gives back an admission the entrance no longer wants. Any other outcome holds nothing to give back. */
function releaseAdmission(outcome: ArrivalOutcome): void {
  if (outcome.type === "admitted") void outcome.joined.session.leave().catch(() => undefined);
}

async function replacePublicSpaceHistory(_canonicalSlug: string, inviteLink: string): Promise<void> {
  globalThis.history?.replaceState(globalThis.history.state, "", inviteLink);
}
