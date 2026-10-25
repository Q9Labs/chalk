import { PrivacyNotice } from "../privacy/PrivacyNotice";
import { useTheme } from "../../lib/theme-context";
import type { ThemeMode } from "../../lib/theme";
import { readReloadRejoin, writeReloadRejoin, reloadRejoinStorageKey, ArrivalUnavailableError, SpacePublicInviteUnavailableError, type ClientFailure, type JoinOptions, type ReloadRejoinMarker } from "@q9labsai/chalk-client";
import { Chalk, CallLimbo, ChalkButton, StatusSurface, ReportProblemDialog } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { publicAPIBaseURL, createPreparedPublicSpace, createPublicInviteClient, resumePublicSpace, type PublicSpaceCredential, type SpaceAccessCleanupOptions, type PreparedPublicSpace, type PublicInviteClient } from "../../lib/chalk-access";
import { getAccount } from "../../lib/account-api";
import { createLocalSpaceClient, createLocalSpaceRelease } from "../../lib/local-space-client";
type WebJoinSettings = Required<Pick<JoinOptions, "displayName" | "microphone" | "camera">>;
import { problemReporter, reportCredentialExpiredReason, useProblemReports, useReportCredentialExpired, type ReportProblem } from "../../lib/problem-reports";
const displayNameStorageKey = "chalk.display-name";
const devicesOff = { microphone: false, camera: false };
const neutralSpaceError = "This Space is unavailable. Please check the invite link and try again.";
type EntryFailure = { readonly message: string; readonly retryable: boolean };
type ExitPhase = "left" | "episode-ended" | "removed" | "failed";
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
        <PrivacyNotice />
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
  const defaultJoinOptions = useMemo<WebJoinSettings>(() => ({ displayName, ...devicesOff }), [displayName]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const arrival = pendingRef.current;
      if (arrival?.arrival.arrival_handle) void client.leaveSpacePublicInviteArrival(arrival.arrival.arrival_handle).catch(() => undefined);
    };
  }, [client]);
  const complete = useCallback((prepared: SpaceEntryAccess, inviteLink: string | undefined, spaceName: string | undefined) => {
    if (!active.current) {
      void prepared.finish().catch(() => undefined);
      return;
    }
    pendingRef.current = null;
    setPending(null);
    setSpaceAccess({ prepared, inviteLink, spaceName });
  }, []);
  useEffect(() => {
    if (reloadAttempted.current || !reloadMarker) return;
    reloadAttempted.current = true;
    const marker = reloadMarker;
    setDisplayName(marker.displayName);
    setEntranceSettings({ displayName: marker.displayName, ...devicesOff });
    setPreparing(true);
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
      if (!normalizedDisplayName || spaceAccess || pending || preparing) return;
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
      const preparation = arrive(client, normalizedDisplayName, slug, inviteToken);
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
    [client, complete, defaultJoinOptions, inviteCode, navigatePublicSpace, pending, preparing, slug, spaceAccess],
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
  const renderSurface = () => {
    if (terminal)
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
            rejoinDisabled={Boolean(spaceAccess) || preparing}
            onRejoin={() => {
              setTerminal(null);
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
    if (spaceAccess) {
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
          ) : preparing || (!reloadMarker && automaticName && !autoArrivalAttempted.current) ? (
            <CallLimbo theme={{ colorScheme: mode }} spaceName={callName} message={`Joining ${callName ?? "the call"}…`} />
          ) : error ? (
            <CallLimbo theme={{ colorScheme: mode }} spaceName={callName} message={error.message} action={error.retryable ? { label: "Ask again", onClick: () => start() } : undefined} />
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
      {sendReport ? (
        <ReportProblemDialog
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
type SpaceEntryAccess = Pick<PreparedPublicSpace, "arrival" | "credential" | "getAccess" | "subscribe" | "reportCredential" | "reportCredentialExpiresAt"> & {
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

function LocalSpace({
  reportCredential,
  reportCredentialExpiresAt,
  reportsAvailable,
  reportUnavailableReason,
  onOpenReportProblem,
  reloadMarker,
  credential,
  hostCanExtend,
  displayName,
  defaults,
  getAccess,
  connectionAccess,
  onFinish,
  spaceName,
  inviteLink,
  onTerminal,
}: {
  readonly reportCredential: () => string;
  readonly reportCredentialExpiresAt: () => number;
  readonly reportsAvailable: boolean;
  readonly reportUnavailableReason?: string;
  readonly onOpenReportProblem: (send: ReportProblem, diagnostics: string) => void;
  readonly reloadMarker: SpaceEntryAccess["reloadMarker"];
  readonly credential: PublicSpaceCredential;
  readonly hostCanExtend: boolean;
  readonly displayName: string;
  readonly defaults: {
    readonly microphone: boolean;
    readonly camera: boolean;
  };
  readonly getAccess: PreparedPublicSpace["getAccess"];
  readonly connectionAccess?: PreparedPublicSpace["connectionAccess"];
  readonly inviteLink?: string;
  readonly onFinish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
  readonly spaceName?: string;
  readonly onTerminal: (phase: ExitPhase, cleanup: () => Promise<void>, failure?: ClientFailure | null, reportProblem?: ReportProblem, reportExpiresAt?: number, endReason?: string) => void;
}) {
  const { mode, setPreference } = useTheme();
  const client = useMemo(() => createLocalSpaceClient({ credential, getAccess, connectionAccess }), [connectionAccess, credential, getAccess]);
  const release = useMemo(() => createLocalSpaceRelease(client, () => onFinish()), [client, onFinish]);
  const [homeError, setHomeError] = useState<string | null>(null);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const tenantId = reloadMarker().tenantId;
  const reportProblem = useMemo(() => problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: reportCredential, connection: () => client.getSnapshot().connection }), [credential.apiBaseURL, tenantId, reportCredential, client]);
  const pendingRelease = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const intentionallyLeft = useRef(false);
  const endObserved = useRef(false);
  const releaseFromLifecycle = useCallback(
    (phase: ExitPhase, failure?: ClientFailure | null) => {
      if (endObserved.current) return;
      endObserved.current = true;
      intentionallyLeft.current = true;
      try {
        globalThis.sessionStorage.removeItem(reloadRejoinStorageKey);
      } catch {
        /* Storage may be disabled. */
      }
      const terminalProof = reportCredential();
      onTerminal(phase, release, failure, problemReporter({ baseURL: credential.apiBaseURL, tenantId, mediaProof: () => terminalProof, connection: () => ({ status: phase, lastError: failure ?? null }) }), reportCredentialExpiresAt(), client.getSnapshot().connection.episodeEndReason);
    },
    [client, onTerminal, release, credential.apiBaseURL, tenantId, reportCredential, reportCredentialExpiresAt],
  );
  useEffect(() => {
    if (connection.episodeEnded) releaseFromLifecycle("episode-ended");
    else if (connection.removedByHost) releaseFromLifecycle("removed");
    else if (connection.status === "failed") releaseFromLifecycle(connection.lastError?.code === "episode.ended" ? "episode-ended" : "failed", connection.lastError);
  }, [connection, releaseFromLifecycle]);

  useEffect(() => {
    if (pendingRelease.current !== undefined) {
      globalThis.clearTimeout(pendingRelease.current);
      pendingRelease.current = undefined;
    }
    return () => {
      pendingRelease.current = globalThis.setTimeout(() => {
        pendingRelease.current = undefined;
        void release().catch(() => undefined);
      }, 0);
    };
  }, [release]);
  useEffect(() => {
    const releaseOnPageHide = (event: PageTransitionEvent) => {
      if (event.persisted || intentionallyLeft.current) return;
      const snapshot = client.getSnapshot();
      if (snapshot.connection.status !== "live" && snapshot.connection.status !== "reconnecting") return;
      try {
        writeReloadRejoin(globalThis.sessionStorage, {
          ...reloadMarker(),
          space: globalThis.location.pathname.split("/").at(-1) ?? credential.space,
          displayName: snapshot.self.displayName ?? displayName,
          microphone: snapshot.media.local.microphone.state === "enabled",
          camera: snapshot.media.local.camera.state === "enabled",
        });
      } catch {
        // Without a recoverable tab marker, retain the existing release behavior.
        void onFinish({ keepalive: true }).catch(() => undefined);
      }
    };
    globalThis.addEventListener("pagehide", releaseOnPageHide);
    return () => globalThis.removeEventListener("pagehide", releaseOnPageHide);
  }, [client, credential.space, displayName, onFinish, reloadMarker]);
  return (
    <main className="h-full min-h-0 w-full overflow-hidden">
      {homeError ? <p role="alert">{homeError}</p> : null}
      <Chalk
        timeLimit={{
          message: hostCanExtend ? "The host can extend this call." : "Sign up free for calls up to 24 hours.",
          action: hostCanExtend ? undefined : { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") },
          endAction: hostCanExtend ? undefined : { label: "Sign up free", onClick: () => globalThis.location.assign("/dashboard/sign-in") },
        }}
        theme={{ colorScheme: mode }}
        onColorSchemeChange={setPreference}
        client={client}
        onReportProblem={reportsAvailable ? reportProblem : undefined}
        reportUnavailableReason={reportUnavailableReason}
        onOpenReportProblem={() => onOpenReportProblem(reportProblem, `Call: ${spaceName ?? "Call"}\nStatus: ${connection.status}`)}
        displayName={displayName}
        defaults={defaults}
        spaceName={spaceName}
        inviteLink={inviteLink}
        onEpisodeEnded={() => releaseFromLifecycle("episode-ended")}
        onLeft={() => {
          const latest = client.getSnapshot().connection;
          releaseFromLifecycle(latest.episodeEnded ? "episode-ended" : latest.removedByHost ? "removed" : "left");
        }}
        onJoined={() => {
          intentionallyLeft.current = false;
        }}
        onHome={() => {
          void release()
            .then(() => globalThis.location.assign("/"))
            .catch(() => setHomeError("Couldn’t leave the call. Try Home again."));
        }}
      />
    </main>
  );
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
