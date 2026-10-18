import { useTheme } from "../../lib/theme-context";
import { readReloadRejoin, writeReloadRejoin, reloadRejoinStorageKey, type JoinOptions, type ReloadRejoinMarker } from "@q9labsai/chalk-client";
import { Chalk, CallLimbo, ChalkButton, StatusSurface } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPreparedPublicSpace, createPublicInviteClient, joinDashboardSpace, resumePublicSpace, type AccountSpaceCredential, type PublicSpaceCredential, type SpaceAccessCleanupOptions, type PreparedPublicSpace, type PublicInviteClient } from "../../lib/chalk-access";
import { getAccount, listAllAccountTenants } from "../../lib/account-api";
import { canonicalSpaceInviteLink, clearDashboardSpaceEntry, hasDashboardSpaceEntry, spaceInviteToken, verifiedSpaceInviteLink } from "../../lib/named-space-route";
import { createLocalSpaceClient, createLocalSpaceRelease } from "../../lib/local-space-client";
type WebJoinSettings = Required<Pick<JoinOptions, "displayName" | "microphone" | "camera">>;
const displayNameStorageKey = "chalk.display-name";
const devicesOff = { microphone: false, camera: false };
const neutralSpaceError = "This Space is unavailable. Please check the invite link and try again.";
type ExitPhase = "left" | "episode-ended" | "failed";
export function SpacePage({
  slug,
  navigatePublicSpace = replacePublicSpaceHistory,
}: {
  readonly slug?: string;
  readonly navigatePublicSpace?: (canonicalSlug: string, inviteLink: string) => Promise<void>;
} = {}) {
  const { mode } = useTheme();
  const [terminal, setTerminal] = useState<{ readonly phase: ExitPhase; readonly callName: string; readonly reason: string | undefined; readonly cleanup: () => Promise<void> } | null>(null);
  const client = useMemo(() => createPublicInviteClient(), []);
  const [reloadMarker] = useState(() => {
    if (!slug) return null;
    try {
      return readReloadRejoin(globalThis.sessionStorage, slug);
    } catch {
      return null; // Storage may be disabled; manual entry remains available.
    }
  });
  const [dashboardEntry] = useState(() => hasDashboardSpaceEntry() || Boolean(reloadMarker?.tenantId));
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
  const [callName, setCallName] = useState(slug ?? "Call");
  const autoArrivalAttempted = useRef(false);
  const nameEdited = useRef(false);
  const [spaceAccess, setSpaceAccess] = useState<JoinedSpaceAccess | null>(null);
  const [pending, setPending] = useState<PendingArrival | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(Boolean(reloadMarker));
  const active = useRef(true);
  const reloadAttempted = useRef(false);
  const pendingRef = useRef<PendingArrival | null>(null);
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
  const complete = useCallback((prepared: SpaceEntryAccess, inviteLink: string | undefined, spaceName: string) => {
    if (!active.current) {
      void prepared.finish().catch(() => undefined);
      return;
    }
    pendingRef.current = null;
    setPending(null);
    setSpaceAccess({ prepared, inviteLink, spaceName });
  }, []);
  useEffect(() => {
    if (reloadAttempted.current || !slug || !reloadMarker) return;
    reloadAttempted.current = true;
    const marker = reloadMarker;
    setDisplayName(marker.displayName);
    setEntranceSettings({ displayName: marker.displayName, ...devicesOff });
    setPreparing(true);
    const recovery = marker.arrivalHandle ? resumePublicSpace(client, marker).then((prepared) => ({ prepared, spaceName: slug })) : prepareDashboardSpace(slug, marker.displayName, marker).then((result) => ({ prepared: result.access, spaceName: result.spaceName }));
    void recovery
      .then((result) => complete(result.prepared, undefined, result.spaceName))
      .catch(() => {
        if (active.current) setError("Could not return to the Episode. Check your access before joining again.");
      })
      .finally(() => {
        if (active.current) setPreparing(false);
      });
  }, [client, complete, reloadMarker, slug]);
  const start = useCallback(
    (settings: WebJoinSettings = defaultJoinOptions) => {
      const normalizedDisplayName = settings.displayName.trim();
      const inviteToken = spaceInviteToken();
      if (!normalizedDisplayName || spaceAccess || pending || preparing) return;
      setDisplayName(normalizedDisplayName);
      setEntranceSettings({ displayName: normalizedDisplayName, ...devicesOff });
      try {
        globalThis.localStorage.setItem(displayNameStorageKey, normalizedDisplayName);
      } catch {
        /* Joining works with storage disabled. */
      }
      const accountEntry = Boolean(slug && !inviteToken && dashboardEntry);
      if (slug && !inviteToken && !accountEntry) {
        setError(neutralSpaceError);
        return;
      }
      setError(null);
      setPreparing(true);
      const preparation = accountEntry ? prepareDashboardSpace(slug!, normalizedDisplayName) : arrive(client, normalizedDisplayName, slug, inviteToken);
      void preparation
        .then(async (result) => {
          if (result.kind === "dashboard") {
            complete(result.access, result.inviteLink, result.spaceName);
            return;
          }
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
    [client, complete, dashboardEntry, defaultJoinOptions, navigatePublicSpace, pending, preparing, slug, spaceAccess],
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
    pendingRef.current = pending;
    if (!pending?.arrival.arrival_handle) return;
    let cancelled = false;
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const poll = async () => {
      try {
        const arrival = await client.getSpacePublicInviteArrival(pending.arrival.arrival_handle ?? "");
        if (cancelled || !active.current) return;
        if (arrival.state === "pending") {
          timer = globalThis.setTimeout(poll, retryDelay(arrival.retry_after));
          return;
        }
        if (arrival.state !== "admitted") throw new AdmissionError(arrival.state);
        const resumed = arrival.access ? arrival : await resumePendingArrival(client, pending, displayName);
        const prepared = createPreparedPublicSpace(client, resumed);
        if (cancelled || !active.current) {
          await prepared.finish().catch(() => undefined);
          return;
        }
        complete(prepared, pending.inviteLink, pending.spaceName);
      } catch (cause) {
        if (!cancelled && active.current) {
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
  }, [client, complete, displayName, pending]);
  const cancel = useCallback(async () => {
    const arrivalHandle = pending?.arrival.arrival_handle;
    if (!arrivalHandle || preparing) return;
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
  if (terminal)
    return (
      <main className="relative h-dvh">
        <StatusSurface
          phase={terminal.phase}
          callName={terminal.callName}
          reason={terminal.reason}
          theme={{ colorScheme: mode }}
          rejoinDisabled={Boolean(spaceAccess) || preparing}
          onRejoin={() => {
            setTerminal(null);
            start(entranceSettings ?? defaultJoinOptions);
          }}
          onHome={() => {
            void terminal
              .cleanup()
              .then(() => globalThis.location.assign("/"))
              .catch(() => setError("Couldn’t leave the call. Try again."));
          }}
        />
        {error ? (
          <p role="alert" className="absolute inset-x-6 bottom-6 text-center text-sm">
            {error}
          </p>
        ) : null}
      </main>
    );
  if (spaceAccess) {
    const settings = entranceSettings ?? defaultJoinOptions;
    return (
      <LocalSpace
        reloadMarker={spaceAccess.prepared.reloadMarker}
        credential={spaceAccess.prepared.credential}
        displayName={settings.displayName}
        defaults={{ microphone: settings.microphone, camera: settings.camera }}
        getAccess={spaceAccess.prepared.getAccess}
        connectionAccess={spaceAccess.prepared.connectionAccess}
        onFinish={finish}
        spaceName={spaceAccess.spaceName}
        inviteLink={spaceAccess.inviteLink}
        onTerminal={(phase, cleanup, reason) => {
          setTerminal({ phase, cleanup, reason, callName: spaceAccess.spaceName });
          void cleanup().catch(() => setError("Couldn’t leave the call. Try Home again."));
        }}
      />
    );
  }
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      {pending ? (
        <CallLimbo spaceName={pending.spaceName} message={error ?? `Asking to join ${pending.spaceName}`} detail={error ? undefined : "The host will let you in."} action={{ label: "Cancel", onClick: () => void cancel(), disabled: preparing }} />
      ) : preparing || (!reloadMarker && automaticName && !autoArrivalAttempted.current) ? (
        <CallLimbo spaceName={callName} message={`Joining ${callName}…`} />
      ) : error ? (
        <CallLimbo spaceName={callName} message={error} action={{ label: "Ask again", onClick: () => start() }} />
      ) : (
        <NameNeeded
          spaceName={callName}
          displayName={displayName}
          onDisplayNameChange={(name) => {
            nameEdited.current = true;
            setDisplayName(name);
          }}
          onJoin={() => start()}
        />
      )}
    </main>
  );
}
type JoinedSpaceAccess = {
  readonly prepared: SpaceEntryAccess;
  readonly inviteLink?: string;
  readonly spaceName: string;
};
type SpaceEntryAccess = Pick<PreparedPublicSpace, "credential" | "getAccess"> & {
  readonly reloadMarker: () => Pick<ReloadRejoinMarker, "episodeId" | "participantId" | "participantGeneration" | "mediaProof" | "arrivalHandle" | "tenantId">;
  readonly connectionAccess?: PreparedPublicSpace["connectionAccess"];
  readonly finish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
};
type PendingArrival = {
  readonly arrival: Awaited<ReturnType<PublicInviteClient["getSpacePublicInviteArrival"]>>;
  readonly inviteLink: string;
  readonly spaceName: string;
};
type PublicPreparation = {
  readonly kind: "public";
  readonly arrival: PendingArrival["arrival"];
  readonly canonicalSlug: string;
  readonly inviteLink: string;
  readonly spaceName: string;
  readonly prepared?: SpaceEntryAccess;
};
type DashboardPreparation = {
  readonly kind: "dashboard";
  readonly access: SpaceEntryAccess;
  readonly inviteLink?: string;
  readonly spaceName: string;
};
async function arrive(client: PublicInviteClient, displayName: string, slug: string | undefined, inviteToken: string | undefined): Promise<PublicPreparation> {
  if (inviteToken) {
    const arrival = await client.arriveBySpacePublicInvite(inviteToken, displayName);
    const verifiedSlug = arrival.space?.slug ?? slug;
    if (!verifiedSlug) throw new Error(neutralSpaceError);
    const inviteLink = canonicalSpaceInviteLink(verifiedSlug, inviteToken);
    return { kind: "public", arrival, canonicalSlug: verifiedSlug, inviteLink, spaceName: arrival.space?.name ?? verifiedSlug };
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
async function prepareDashboardSpace(slug: string, displayName: string, reload?: ReloadRejoinMarker): Promise<DashboardPreparation> {
  const tenantID = reload?.tenantId ?? (await resolveTenantID());
  if (!tenantID) throw new Error(neutralSpaceError);
  const access = await (reload ? joinDashboardSpace(tenantID, slug, displayName, reload) : joinDashboardSpace(tenantID, slug, displayName));
  clearDashboardSpaceEntry();
  return { kind: "dashboard", access: { credential: access.credential, getAccess: access.getAccess, reloadMarker: access.reloadMarker, finish: access.leave }, inviteLink: access.inviteLink, spaceName: slug };
}
async function resolveTenantID(): Promise<string> {
  let hint: string | undefined;
  try {
    hint = globalThis.localStorage?.getItem("chalk.tenant-hint")?.trim();
  } catch {
    // Storage is an optimization; the account list remains authoritative.
  }
  const tenants = await listAllAccountTenants();
  const tenantID = (tenants.find((item) => item.tenant.id === hint) ?? tenants[0])?.tenant.id ?? "";
  if (tenantID) {
    try {
      globalThis.localStorage?.setItem("chalk.tenant-hint", tenantID);
    } catch {
      // Storage is an optimization; the current request remains authoritative.
    }
  }
  return tenantID;
}
function retryDelay(retryAfter: number | undefined): number {
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return 1000;
  return Math.min(Math.max(retryAfter * 1000, 250), 30000);
}
async function resumePendingArrival(client: PublicInviteClient, pending: PendingArrival, displayName: string): Promise<Awaited<ReturnType<PublicInviteClient["arriveBySpacePublicInvite"]>>> {
  const inviteToken = spaceInviteToken();
  const arrivalHandle = pending.arrival.arrival_handle;
  if (!inviteToken || !arrivalHandle) throw new Error(neutralSpaceError);
  return client.arriveBySpacePublicInvite(inviteToken, displayName.trim(), { arrivalHandle });
}
class AdmissionError extends Error {
  constructor(readonly state: string) {
    super(state);
  }
}
function neutralMessage(cause: unknown): string {
  if (cause instanceof AdmissionError) {
    if (cause.state === "rejected") return "The host declined your request to join.";
    if (cause.state === "unavailable") return "Your request to join expired or is no longer available.";
    return "Your request to join is no longer active.";
  }
  if (cause && typeof cause === "object" && "status" in cause) {
    if (cause.status === 404 || cause.status === 410) return neutralSpaceError;
    if (cause.status === 401) return "Sign in again, then enter this Space.";
    if (cause.status === 403) return "You do not have access to this Space. Ask the owner for access.";
    if (cause.status === 429) return "Too many requests. Wait a minute, then enter this Space again.";
    if (cause.status === 409) return "You could not enter this Space. Try entering again.";
  }
  return "Chalk could not connect. Check your connection and try entering again.";
}
function LocalSpace({
  reloadMarker,
  credential,
  displayName,
  defaults,
  getAccess,
  connectionAccess,
  onFinish,
  spaceName,
  inviteLink,
  onTerminal,
}: {
  readonly reloadMarker: SpaceEntryAccess["reloadMarker"];
  readonly credential: PublicSpaceCredential | AccountSpaceCredential;
  readonly displayName: string;
  readonly defaults: {
    readonly microphone: boolean;
    readonly camera: boolean;
  };
  readonly getAccess: PreparedPublicSpace["getAccess"];
  readonly connectionAccess?: PreparedPublicSpace["connectionAccess"];
  readonly inviteLink?: string;
  readonly onFinish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
  readonly spaceName: string;
  readonly onTerminal: (phase: ExitPhase, cleanup: () => Promise<void>, reason?: string) => void;
}) {
  const { mode, setPreference } = useTheme();
  const client = useMemo(() => createLocalSpaceClient({ credential, getAccess, connectionAccess }), [connectionAccess, credential, getAccess]);
  const release = useMemo(() => createLocalSpaceRelease(client, () => onFinish()), [client, onFinish]);
  const [homeError, setHomeError] = useState<string | null>(null);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const pendingRelease = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const intentionallyLeft = useRef(false);
  const endObserved = useRef(false);
  const releaseFromLifecycle = useCallback(
    (phase: ExitPhase, reason?: string) => {
      if (endObserved.current) return;
      endObserved.current = true;
      intentionallyLeft.current = true;
      try {
        globalThis.sessionStorage.removeItem(reloadRejoinStorageKey);
      } catch {
        /* Storage may be disabled. */
      }
      onTerminal(phase, release, reason);
    },
    [onTerminal, release],
  );
  useEffect(() => {
    if (connection.status === "failed") releaseFromLifecycle("failed", connection.lastError?.message);
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
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      {homeError ? <p role="alert">{homeError}</p> : null}
      <Chalk
        theme={{ colorScheme: mode }}
        onColorSchemeChange={setPreference}
        client={client}
        displayName={displayName}
        defaults={defaults}
        spaceName={spaceName}
        inviteLink={inviteLink}
        onEpisodeEnded={() => releaseFromLifecycle("episode-ended")}
        onLeft={() => releaseFromLifecycle("left")}
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
export function NameNeeded({ spaceName, displayName, onDisplayNameChange, onJoin }: { readonly spaceName: string; readonly displayName: string; readonly onDisplayNameChange: (name: string) => void; readonly onJoin: () => void }) {
  return (
    <CallLimbo spaceName={spaceName} message={`Join ${spaceName}`}>
      <form
        className="mt-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (displayName.trim()) onJoin();
        }}
      >
        <label htmlFor="join-display-name" className="mb-2 block text-sm text-[var(--chalk-app-text-muted)]">
          Your name
        </label>
        <input
          id="join-display-name"
          autoComplete="name"
          autoFocus
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          className="h-11 w-full rounded-xl border border-[var(--chalk-app-line-strong)] bg-[var(--chalk-app-panel)] px-3 text-center text-[var(--chalk-app-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--chalk-app-control-active-line)]"
        />
        <ChalkButton type="submit" variant="outline" className="mt-4 !h-11" disabled={!displayName.trim()}>
          Join
        </ChalkButton>
      </form>
    </CallLimbo>
  );
}
