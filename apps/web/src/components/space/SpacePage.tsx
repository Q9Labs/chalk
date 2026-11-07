import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { useTheme } from "../../lib/theme-context";
import type { ThemeMode } from "../../lib/theme";
import { readReloadRejoin, ArrivalUnavailableError, SpacePublicInviteUnavailableError, type ClientFailure, type JoinOptions, type ReloadRejoinMarker } from "@q9labsai/chalk-client";
import { CallLimbo, ChalkButton } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { publicAPIBaseURL, createPreparedPublicSpace, createPublicInviteClient, resumePublicSpace, type SpaceAccessCleanupOptions, type PreparedPublicSpace, type PublicInviteClient } from "../../lib/chalk-access";
import { getAccount } from "../../lib/account-api";
import { reloadAfterChunkLoadFailure } from "../../lib/chunkReload";
import type * as CallSurface from "./SpaceCall";
type WebJoinSettings = Required<Pick<JoinOptions, "displayName" | "microphone" | "camera">>;
import { reportCredentialExpiredReason, useProblemReports, useReportCredentialExpired, type ReportProblem } from "../../lib/problem-reports";
const displayNameStorageKey = "chalk.display-name";
const devicesOff = { microphone: false, camera: false };
const neutralSpaceError = "This Space is unavailable. Please check the invite link and try again.";
type EntryFailure = { readonly message: string; readonly retryable: boolean };
export type ExitPhase = "left" | "episode-ended" | "removed" | "failed";
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
  const [terminal, setTerminal] = useState<{
    readonly phase: ExitPhase;
    readonly endReason?: string;
    readonly hostCanExtend?: boolean;
    readonly tenantId: string | undefined;
    readonly callName: string | undefined;
    readonly failure: ClientFailure | null | undefined;
    readonly cleanup: () => Promise<void>;
    readonly reportProblem?: ReportProblem;
    readonly reportExpiresAt?: number;
  } | null>(null);
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
  const [displayName, setDisplayName] = useState(reloadMarker?.displayName ?? automaticName);
  const [entranceSettings, setEntranceSettings] = useState<WebJoinSettings | null>(reloadMarker ? { displayName: reloadMarker.displayName, ...devicesOff } : null);
  const [callName, setCallName] = useState<string>();
  const autoArrivalAttempted = useRef(false);
  const nameEdited = useRef(false);
  const [spaceAccess, setSpaceAccess] = useState<JoinedSpaceAccess | null>(null);
  const [callSurface, setCallSurface] = useState<typeof CallSurface | null>(null);
  const subscribeReportAccess = useCallback((listener: () => void) => spaceAccess?.prepared.subscribe(listener) ?? (() => undefined), [spaceAccess]);
  const reportAccessExpiry = useCallback(() => spaceAccess?.prepared.reportCredentialExpiresAt(), [spaceAccess]);
  const liveReportExpiresAt = useSyncExternalStore(subscribeReportAccess, reportAccessExpiry, reportAccessExpiry);
  const reportExpired = useReportCredentialExpired(terminal?.reportExpiresAt ?? liveReportExpiresAt);
  const reportsAvailable = useProblemReports(publicAPIBaseURL(), spaceAccess?.prepared.reloadMarker().tenantId ?? terminal?.tenantId);
  const [pending, setPending] = useState<PendingArrival | null>(null);
  const [error, setError] = useState<EntryFailure | null>(null);
  const [preparing, setPreparing] = useState(Boolean(reloadMarker));
  const active = useRef(true);
  const reloadAttempted = useRef(false);
  const pendingRef = useRef<PendingArrival | null>(null);
  const cancelRequested = useRef(false);
  const cleanupPromise = useRef<Promise<void> | undefined>(undefined);
  const retryAfterRelease = useRef(false);
  // The entrance releases an admitted arrival until LocalSpace mounts and takes over its release.
  const entranceAccess = useRef<SpaceEntryAccess | null>(null);
  const defaultJoinOptions = useMemo<WebJoinSettings>(() => ({ displayName, ...devicesOff }), [displayName]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const arrival = pendingRef.current;
      if (arrival?.arrival.arrival_handle) void client.leaveSpacePublicInviteArrival(arrival.arrival.arrival_handle).catch(() => undefined);
      const access = entranceAccess.current;
      entranceAccess.current = null;
      if (access) void (cleanupPromise.current ?? Promise.reject(new Error("Not released."))).catch(() => access.finish()).catch(() => undefined);
    };
  }, [client]);
  const complete = useCallback((prepared: SpaceEntryAccess, inviteLink: string | undefined, spaceName: string | undefined) => {
    if (!active.current) {
      void prepared.finish().catch(() => undefined);
      return;
    }
    pendingRef.current = null;
    setPending(null);
    entranceAccess.current = prepared;
    setSpaceAccess({ prepared, inviteLink, spaceName });
  }, []);
  useEffect(() => {
    if (reloadAttempted.current || !reloadMarker) return;
    reloadAttempted.current = true;
    const marker = reloadMarker;
    setDisplayName(marker.displayName);
    setEntranceSettings({ displayName: marker.displayName, ...devicesOff });
    setPreparing(true);
    void loadCallSurface().catch(() => undefined);
    const recovery = resumePublicSpace(client, marker, slug).then((prepared) => ({ prepared, spaceName: prepared.arrival.space?.name }));
    void recovery
      .then((result) => complete(result.prepared, undefined, result.spaceName))
      .catch(() => {
        if (active.current) setError({ message: "Could not return to the Episode. Check your access before joining again.", retryable: true });
      })
      .finally(() => {
        if (active.current) setPreparing(false);
      });
  }, [client, complete, reloadMarker, slug]);
  const start = useCallback(
    (settings: WebJoinSettings = defaultJoinOptions) => {
      const normalizedDisplayName = settings.displayName.trim();
      const inviteToken = inviteCode ?? spaceInviteToken();
      if (!normalizedDisplayName || (spaceAccess && !terminal) || pending || preparing) return;
      setDisplayName(normalizedDisplayName);
      setEntranceSettings({ displayName: normalizedDisplayName, ...devicesOff });
      try {
        globalThis.localStorage.setItem(displayNameStorageKey, normalizedDisplayName);
      } catch {
        /* Joining works with storage disabled. */
      }
      if ((slug || inviteCode) && !inviteToken) {
        setError({ message: neutralSpaceError, retryable: false });
        return;
      }
      cancelRequested.current = false;
      setError(null);
      setPreparing(true);
      void loadCallSurface().catch(() => undefined);
      const preparation = terminal
        ? terminal.cleanup().then(() => {
            if (!active.current) return Promise.reject(new Error("Space entry was closed."));
            setTerminal(null);
            return arrive(client, normalizedDisplayName, slug, inviteToken);
          })
        : arrive(client, normalizedDisplayName, slug, inviteToken);
      void preparation
        .then(async (result) => {
          try {
            await navigatePublicSpace(result.canonicalSlug, result.inviteLink);
          } catch (cause) {
            await releasePublicPreparation(client, result);
            throw cause;
          }
          if (!active.current) {
            await releasePublicPreparation(client, result);
            return;
          }
          const { arrival, inviteLink, spaceName } = result;
          setCallName(spaceName);
          if (arrival.state === "pending") {
            const nextPending = { arrival, inviteLink, spaceName } satisfies PendingArrival;
            pendingRef.current = nextPending;
            setPending(nextPending);
            return;
          }
          if (arrival.state !== "admitted") throw new AdmissionError(arrival.state);
          const prepared = result.prepared ?? createPreparedPublicSpace(client, arrival);
          complete(prepared, inviteLink, spaceName);
        })
        .catch((cause: unknown) => {
          if (active.current) setError(neutralMessage(cause));
        })
        .finally(() => {
          if (active.current) setPreparing(false);
        });
    },
    [client, complete, defaultJoinOptions, inviteCode, navigatePublicSpace, pending, preparing, slug, spaceAccess, terminal],
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
    if (!automaticName || reloadMarker || autoArrivalAttempted.current) return;
    autoArrivalAttempted.current = true;
    start({ displayName: automaticName, ...devicesOff });
  }, [automaticName, reloadMarker, start]);
  useEffect(() => {
    if (preparing || cancelRequested.current) return;
    pendingRef.current = pending;
    if (!pending?.arrival.arrival_handle) return;
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      try {
        const arrival = await client.getSpacePublicInviteArrival(pending.arrival.arrival_handle ?? "");
        if (cancelled || cancelRequested.current || !active.current || pendingRef.current !== pending) return;
        if (arrival.state === "pending") {
          timer = globalThis.setTimeout(poll, retryDelay(arrival.retry_after));
          return;
        }
        if (arrival.state !== "admitted") throw new AdmissionError(arrival.state);
        const resumed = arrival.access ? arrival : await resumePendingArrival(client, pending, displayName, inviteCode);
        const prepared = createPreparedPublicSpace(client, resumed);
        if (cancelled || cancelRequested.current || !active.current || pendingRef.current !== pending) {
          await prepared.finish().catch(() => undefined);
          return;
        }
        complete(prepared, pending.inviteLink, pending.spaceName);
      } catch (cause) {
        if (!cancelled && !cancelRequested.current && active.current && pendingRef.current === pending) {
          pendingRef.current = null;
          setPending(null);
          setError(neutralMessage(cause));
        }
      }
    };
    timer = globalThis.setTimeout(poll, retryDelay(pending.arrival.retry_after));
    return () => {
      cancelled = true;
      if (timer !== undefined) globalThis.clearTimeout(timer);
    };
  }, [client, complete, displayName, inviteCode, pending, preparing]);
  const cancel = useCallback(async () => {
    const arrivalHandle = pending?.arrival.arrival_handle;
    if (!arrivalHandle || preparing) return;
    cancelRequested.current = true;
    setError(null);
    setPreparing(true);
    try {
      await client.leaveSpacePublicInviteArrival(arrivalHandle);
      pendingRef.current = null;
      setPending(null);
    } catch (cause) {
      setError(neutralMessage(cause));
    } finally {
      if (active.current) setPreparing(false);
    }
  }, [client, pending, preparing]);
  const finish = useCallback(
    (options: SpaceAccessCleanupOptions = {}) => {
      if (cleanupPromise.current) return cleanupPromise.current;
      const attempt =
        spaceAccess?.prepared.finish(options).catch((cause: unknown) => {
          cleanupPromise.current = undefined;
          throw cause;
        }) ?? Promise.resolve();
      const completed = attempt.then(() => {
        if (!options.keepalive && entranceAccess.current === spaceAccess?.prepared) entranceAccess.current = null;
        if (!options.keepalive && active.current) {
          cleanupPromise.current = undefined;
          setSpaceAccess(null);
        }
      });
      cleanupPromise.current = completed;
      return completed;
    },
    [spaceAccess],
  );
  useEffect(() => {
    if (!spaceAccess || callSurface) return;
    let cancelled = false;
    void loadCallSurface().then(
      (surface) => {
        if (!cancelled && active.current) setCallSurface(surface);
      },
      (cause: unknown) => {
        if (cancelled || !active.current) return;
        setError(neutralMessage(cause));
        void finish().then(
          () => reloadAfterChunkLoadFailure(cause),
          () => undefined,
        );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [callSurface, finish, spaceAccess]);
  useEffect(() => {
    // LocalSpace's effects run before this parent effect, so its unmount release is already in place.
    if (spaceAccess && callSurface && !terminal && entranceAccess.current === spaceAccess.prepared) entranceAccess.current = null;
  }, [callSurface, spaceAccess, terminal]);
  useEffect(() => {
    if (!retryAfterRelease.current || spaceAccess) return;
    retryAfterRelease.current = false;
    start();
  }, [spaceAccess, start]);
  const askAgain = () => {
    if (!spaceAccess) return start();
    // An arrival whose call could not load must be released before a new one is requested.
    retryAfterRelease.current = true;
    void finish().catch((cause: unknown) => {
      retryAfterRelease.current = false;
      setError(neutralMessage(cause));
    });
  };
  const renderSurface = () => {
    if (terminal && callSurface) {
      const { StatusSurface } = callSurface;
      return (
        <main className="relative h-full">
          <StatusSurface
            phase={terminal.phase}
            episodeEndReason={terminal.endReason}
            endAction={!terminal.hostCanExtend ? { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") } : undefined}
            callName={terminal.callName}
            errorCode={terminal.failure?.code}
            sync={terminal.failure?.sync}
            theme={{ colorScheme: mode }}
            onReportProblem={
              reportsAvailable && terminal.reportProblem && !reportExpired
                ? () => {
                    setReportOpen(true);
                  }
                : undefined
            }
            rejoinDisabled={preparing}
            onRejoin={() => {
              start(entranceSettings ?? defaultJoinOptions);
            }}
            onHome={() => {
              if (terminal.phase === "episode-ended") {
                void terminal.cleanup().catch(() => undefined);
                globalThis.location.assign("/");
                return;
              }
              void terminal
                .cleanup()
                .then(() => globalThis.location.assign("/"))
                .catch(() => setError({ message: "Couldn’t leave the call. Try again.", retryable: true }));
            }}
          />
          {error ? (
            <p role="alert" className="absolute inset-x-6 bottom-6 text-center text-sm">
              {error.message}
            </p>
          ) : null}
        </main>
      );
    }
    if (spaceAccess && callSurface) {
      const { LocalSpace } = callSurface;
      const settings = entranceSettings ?? defaultJoinOptions;
      return (
        <LocalSpace
          reloadMarker={spaceAccess.prepared.reloadMarker}
          reportCredential={spaceAccess.prepared.reportCredential}
          reportCredentialExpiresAt={spaceAccess.prepared.reportCredentialExpiresAt}
          reportsAvailable={reportsAvailable}
          reportUnavailableReason={reportExpired ? reportCredentialExpiredReason : undefined}
          onOpenReportProblem={(send, diagnostics) => {
            setReportDialog({ send, diagnostics });
            setReportOpen(true);
          }}
          credential={spaceAccess.prepared.credential}
          hostCanExtend={(spaceAccess.prepared.arrival.space?.maximum_episode_duration_seconds ?? 3600) > 3600}
          displayName={settings.displayName}
          defaults={{ microphone: settings.microphone, camera: settings.camera }}
          getAccess={spaceAccess.prepared.getAccess}
          connectionAccess={spaceAccess.prepared.connectionAccess}
          onFinish={finish}
          spaceName={spaceAccess.spaceName}
          inviteLink={spaceAccess.inviteLink}
          onTerminal={(phase, cleanup, failure, reportProblem, reportExpiresAt, endReason) => {
            setTerminal({ phase, cleanup, failure, endReason, hostCanExtend: (spaceAccess.prepared.arrival.space?.maximum_episode_duration_seconds ?? 3600) > 3600, tenantId: spaceAccess.prepared.reloadMarker().tenantId, callName: spaceAccess.spaceName, reportProblem, reportExpiresAt });
            void cleanup().catch(() => setError({ message: "Couldn’t leave the call. Try Home again.", retryable: true }));
          }}
        />
      );
    }
    return (
      <main data-chalk data-chalk-theme={mode} className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="min-h-0 flex-1">
          {pending ? (
            <CallLimbo
              theme={{ colorScheme: mode }}
              spaceName={pending.spaceName}
              message={error?.message ?? `Asking to join ${pending.spaceName ?? "the call"}`}
              detail={error ? undefined : "The host will let you in."}
              action={{ label: "Cancel", onClick: () => void cancel(), disabled: preparing }}
            />
          ) : preparing || (spaceAccess && !error) || (!reloadMarker && automaticName && !autoArrivalAttempted.current) ? (
            <CallLimbo theme={{ colorScheme: mode }} spaceName={callName} message={`Joining ${callName ?? "the call"}…`} />
          ) : error ? (
            <CallLimbo theme={{ colorScheme: mode }} spaceName={callName} message={error.message} action={error.retryable ? { label: "Ask again", onClick: askAgain } : undefined} />
          ) : (
            <NameNeeded
              spaceName={callName}
              theme={mode}
              displayName={displayName}
              onDisplayNameChange={(name) => {
                nameEdited.current = true;
                setDisplayName(name);
              }}
              onJoin={() => start()}
            />
          )}
        </div>
      </main>
    );
  };
  const sendReport = terminal?.reportProblem ?? reportDialog?.send;
  return (
    <div ref={reportFocusScope} className="contents">
      {renderSurface()}
      {sendReport && callSurface ? (
        <callSurface.ReportProblemDialog
          unavailableReason={reportExpired ? reportCredentialExpiredReason : !reportsAvailable ? "Reporting is temporarily unavailable. Your draft is kept here." : undefined}
          diagnostics={terminal ? `Connection: ${terminal.phase}\nLast error: ${terminal.failure?.code ?? "none"}` : (reportDialog?.diagnostics ?? "")}
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
type JoinedSpaceAccess = {
  readonly prepared: SpaceEntryAccess;
  readonly inviteLink?: string;
  readonly spaceName?: string;
};
export type SpaceEntryAccess = Pick<PreparedPublicSpace, "arrival" | "credential" | "getAccess" | "subscribe" | "reportCredential" | "reportCredentialExpiresAt"> & {
  readonly reloadMarker: () => Pick<ReloadRejoinMarker, "episodeId" | "participantId" | "participantGeneration" | "mediaProof" | "arrivalHandle" | "tenantId">;
  readonly connectionAccess?: PreparedPublicSpace["connectionAccess"];
  readonly finish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
};
type PendingArrival = {
  readonly arrival: Awaited<ReturnType<PublicInviteClient["getSpacePublicInviteArrival"]>>;
  readonly inviteLink: string;
  readonly spaceName?: string;
};
type PublicPreparation = {
  readonly kind: "public";
  readonly arrival: PendingArrival["arrival"];
  readonly canonicalSlug: string;
  readonly inviteLink: string;
  readonly spaceName?: string;
  readonly prepared?: SpaceEntryAccess;
};
function spaceInviteToken(): string | undefined {
  if (!globalThis.location) return undefined;
  const value = new URLSearchParams(globalThis.location.hash.slice(1)).get("spaceInviteToken")?.trim();
  return value || undefined;
}

async function arrive(client: PublicInviteClient, displayName: string, slug: string | undefined, inviteToken: string | undefined): Promise<PublicPreparation> {
  const { canonicalSpaceInviteLink, verifiedSpaceInviteLink } = await import("../../lib/named-space-route");
  if (inviteToken) {
    const arrival = await client.arriveBySpacePublicInvite(inviteToken, displayName);
    const verifiedSlug = arrival.space?.slug ?? slug;
    if (!verifiedSlug) throw new Error(neutralSpaceError);
    const inviteLink = canonicalSpaceInviteLink(verifiedSlug, inviteToken);
    return { kind: "public", arrival, canonicalSlug: verifiedSlug, inviteLink, spaceName: arrival.space?.name };
  }
  const created = await client.createPublicSpace(displayName);
  const prepared = createPreparedPublicSpace(client, created.arrival);
  const inviteLink = verifiedSpaceInviteLink(created.space.slug, created.invite_link);
  return { kind: "public", arrival: created.arrival, canonicalSlug: created.space.slug, inviteLink, spaceName: created.space.name, prepared };
}
async function releasePublicPreparation(client: PublicInviteClient, preparation: PublicPreparation): Promise<void> {
  if (preparation.prepared) {
    await preparation.prepared.finish();
    return;
  }
  const arrivalHandle = preparation.arrival.arrival_handle;
  if (arrivalHandle) await client.leaveSpacePublicInviteArrival(arrivalHandle);
}
async function replacePublicSpaceHistory(_canonicalSlug: string, inviteLink: string): Promise<void> {
  globalThis.history?.replaceState(globalThis.history.state, "", inviteLink);
}
function retryDelay(retryAfter: number | undefined): number {
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return 1000;
  return Math.min(Math.max(retryAfter * 1000, 250), 30000);
}
async function resumePendingArrival(client: PublicInviteClient, pending: PendingArrival, displayName: string, inviteCode?: string): Promise<Awaited<ReturnType<PublicInviteClient["arriveBySpacePublicInvite"]>>> {
  const inviteToken = inviteCode ?? spaceInviteToken();
  const arrivalHandle = pending.arrival.arrival_handle;
  if (!inviteToken || !arrivalHandle) throw new Error(neutralSpaceError);
  return client.arriveBySpacePublicInvite(inviteToken, displayName.trim(), { arrivalHandle });
}
class AdmissionError extends Error {
  constructor(readonly state: string) {
    super(state);
  }
}
function neutralMessage(cause: unknown): EntryFailure {
  // Generated public-invite errors keep their contract code across Promise rejection.
  if (cause instanceof SpacePublicInviteUnavailableError) return { message: "This invite link is unavailable. Ask the host for a new link.", retryable: false };
  if (cause instanceof ArrivalUnavailableError) return { message: "Your request to join is no longer available. Open the invite link and join again.", retryable: false };
  if (cause instanceof AdmissionError) {
    if (cause.state === "rejected") return { message: "The host declined your request to join.", retryable: true };
    if (cause.state === "unavailable") return { message: "Your request to join expired or is no longer available.", retryable: true };
    return { message: "Your request to join is no longer active.", retryable: true };
  }
  if (cause && typeof cause === "object" && "status" in cause) {
    if (cause.status === 404 || cause.status === 410) return { message: neutralSpaceError, retryable: false };
    if (cause.status === 401) return { message: "Sign in again, then enter this Space.", retryable: true };
    if (cause.status === 403) return { message: "You do not have access to this Space. Ask the owner for access.", retryable: true };
    if (cause.status === 429) return { message: "Too many requests. Wait a minute, then enter this Space again.", retryable: true };
    if (cause.status === 409) return { message: "You could not enter this Space. Try entering again.", retryable: true };
  }
  return { message: "Chalk could not connect. Check your connection and try entering again.", retryable: true };
}

/** The web asks only for identity. Devices are requested inside the admitted call. */
export function NameNeeded({ spaceName, theme, displayName, onDisplayNameChange, onJoin }: { readonly spaceName?: string; readonly theme: ThemeMode; readonly displayName: string; readonly onDisplayNameChange: (name: string) => void; readonly onJoin: () => void }) {
  return (
    <CallLimbo spaceName={spaceName} message={spaceName ? `Join ${spaceName}` : "Join the call"} theme={{ colorScheme: theme }} className="w-[320px] p-5 max-[640px]:w-[300px]">
      <form
        className="mt-4 flex w-full flex-col gap-2 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          if (displayName.trim()) onJoin();
        }}
      >
        <label htmlFor="join-display-name" className="text-[13px] font-semibold">
          Your name
        </label>
        <input
          id="join-display-name"
          autoComplete="name"
          autoFocus
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          className="h-11 w-full rounded-xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-3.5 text-[var(--chalk-app-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
        />
        <ChalkButton type="submit" variant="solid" className="mt-1.5 !h-11 w-full" disabled={!displayName.trim()}>
          Join call
        </ChalkButton>
      </form>
    </CallLimbo>
  );
}
