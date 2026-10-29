import { readReloadRejoin, reloadRejoinAccess, reloadRejoinStorageKey, writeReloadRejoin, type GetAccess, type SpaceClient } from "@q9labsai/chalk-client";
import { createSpaceClientForPlatform } from "@q9labsai/chalk-client/effect";
import { Chalk } from "@q9labsai/chalk-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { z } from "../../lib/zod-mini";

import type { OwnerAccessDTO } from "../../lib/dashboard/contracts";
import { act, clearOwnerSeats, DashboardRequestError, errorMessage, intentKey, readPage } from "../../lib/dashboard/client";
import { dashboardAccessFailure } from "../../lib/dashboard/owner-access";
import { SiteRoot, useSiteTheme } from "../site/theme";
import { useLoad, useSession } from "./AppShell";
import { ErrorPanel } from "./kit";

import { problemReporter, reportCredentialExpiredReason, useProblemReports, useReportCredentialExpired } from "../../lib/problem-reports";
import { publicAPIBaseURL } from "../../lib/chalk-access";
const ownerReloadIntent = z.object({ ownerJoinKey: z.uuid(), ownerUserId: z.string() });

function readOwnerReload(spaceId: string, userId: string) {
  try {
    const encoded = window.sessionStorage.getItem(reloadRejoinStorageKey);
    const marker = readReloadRejoin(window.sessionStorage, spaceId);
    const saved = encoded ? ownerReloadIntent.safeParse(JSON.parse(encoded)) : null;
    return marker && saved?.success && saved.data.ownerUserId === userId ? { episodeId: marker.episodeId, joinKey: saved.data.ownerJoinKey } : null;
  } catch {
    return null;
  }
}

/** Owner access for one call: `join` admits the owner, `refresh-access` renews the same seat. */
function ownerAccess(spaceId: string, userId: string) {
  const joinStorageKey = `chalk.owner-join:${userId}:${spaceId}`;
  let joinKey = intentKey();
  let hasStoredJoinKey = false;
  try {
    const storedJoinKey = window.sessionStorage.getItem(joinStorageKey);
    hasStoredJoinKey = storedJoinKey !== null;
    joinKey = storedJoinKey ?? joinKey;
    window.sessionStorage.setItem(joinStorageKey, joinKey);
  } catch {
    // The pending-seat lease still covers browsers with tab storage disabled.
  }
  const episodeStorageKey = `${joinStorageKey}:episode`;
  let joined = false;
  let current: OwnerAccessDTO["access"] | undefined;
  let ownerSeat: string | undefined;
  let deadlineCeiling: string | undefined;
  const listeners = new Set<() => void>();
  let recovery: ReturnType<typeof readOwnerReload> | undefined;
  let restoring: Promise<void> | undefined;
  const clearReload = () => {
    try {
      window.sessionStorage.removeItem(reloadRejoinStorageKey);
      if (joined) {
        window.sessionStorage.removeItem(joinStorageKey);
        window.sessionStorage.removeItem(episodeStorageKey);
      }
    } catch {
      // Storage may be disabled; intentional leave must still work.
    }
    if (ownerSeat) {
      ownerSeat = undefined;
      void clearOwnerSeats().catch(() => console.warn(JSON.stringify({ event: "dashboard.seat_cleanup_failed" })));
    }
  };
  const rotateJoinKey = () => {
    joinKey = intentKey();
    try {
      window.sessionStorage.setItem(joinStorageKey, joinKey);
      window.sessionStorage.removeItem(episodeStorageKey);
    } catch {
      /* The old seat is terminal even without tab storage. */
    }
  };
  const join = () => act("call", { action: "join", spaceId, idempotencyKey: joinKey });
  const restore = async () => {
    if (recovery === undefined) recovery = readOwnerReload(spaceId, userId);
    const saved = recovery;
    let pendingEpisode: string | null = null;
    try {
      pendingEpisode = window.sessionStorage.getItem(episodeStorageKey);
    } catch {
      /* Tab storage is optional. */
    }
    if (!saved && !pendingEpisode && !hasStoredJoinKey) return;
    const page = await readPage("call", { spaceId });
    if (saved && page.live?.id === saved.episodeId) joinKey = saved.joinKey;
    else if (!pendingEpisode || page.live?.id !== pendingEpisode) rotateJoinKey();
  };
  const requestAccess = async ({ reason, replaceMediaConnection }: Parameters<GetAccess>[0]) => {
    await (restoring ??= restore().catch((error) => {
      restoring = undefined;
      throw error;
    }));
    const {
      access,
      ownerSeat: sealedSeat,
      deadlineCeiling: ceiling,
    } = reason === "join"
      ? // A Leave can commit while its acknowledgement is lost; its seat then refuses the retained key.
        await join().catch((error: unknown) => {
          if (!(error instanceof DashboardRequestError && error.code === "participant_not_active")) throw error;
          rotateJoinKey();
          return join();
        })
      : // Without the current token the server replaces the media connection.
        await act("call", { action: "refresh-access", spaceId, joinKey, ...(ownerSeat ? { ownerSeat } : {}), ...(!replaceMediaConnection && current ? { currentMediaToken: current.media.token } : {}) });
    current = access;
    ownerSeat = sealedSeat;
    deadlineCeiling = ceiling;
    try {
      window.sessionStorage.setItem(joinStorageKey, joinKey);
      window.sessionStorage.setItem(episodeStorageKey, access.subject.episode_id);
    } catch {
      /* The lease still covers pending admission. */
    }
    for (const listener of listeners) listener();
    return access;
  };
  const getAccess: GetAccess = (input) => requestAccess(input).catch(dashboardAccessFailure);
  const saveReload = (snapshot: ReturnType<SpaceClient["getSnapshot"]>) => {
    if (!current || (snapshot.connection.status !== "live" && snapshot.connection.status !== "reconnecting") || snapshot.connection.episodeEnded || snapshot.connection.removedByHost) return;
    const marker = {
      ...reloadRejoinAccess(current),
      space: spaceId,
      tenantId: current.subject.tenant_id,
      displayName: snapshot.self.displayName ?? "",
      microphone: snapshot.media.local.microphone.state === "enabled",
      camera: snapshot.media.local.camera.state === "enabled",
      ownerJoinKey: joinKey,
      ownerUserId: userId,
    };
    try {
      writeReloadRejoin(window.sessionStorage, marker);
    } catch {
      // Reload recovery is unavailable with tab storage disabled.
    }
  };
  const observe = (snapshot: ReturnType<SpaceClient["getSnapshot"]>) => {
    if (snapshot.connection.status === "live" || snapshot.connection.status === "reconnecting") joined = true;
  };
  return {
    getAccess,
    saveReload,
    clearReload,
    observe,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportAccess: () => current,
    deadlineCeiling: () => deadlineCeiling,
    reportCredential: () => current?.media.token,
  };
}

/** The call screen for the call's owner, through the React SDK's own call UI. */
export function OwnerCall({ spaceId }: { readonly spaceId: string }) {
  const { profile, failure, retry } = useSession();
  const { state, reload } = useLoad(() => readPage("call", { spaceId }), `call:${spaceId}`);
  const { theme, setTheme } = useSiteTheme();
  const navigate = useNavigate();
  const apiBaseURL = publicAPIBaseURL();
  const owner = useMemo(() => ownerAccess(spaceId, profile?.id ?? ""), [spaceId, profile?.id]);
  const [client, setClient] = useState<SpaceClient | null>(null);
  const startKey = useRef(intentKey());
  const startingCall = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  useEffect(() => {
    startKey.current = intentKey();
    startingCall.current = false;
    setStartError(null);
  }, [spaceId]);
  useEffect(() => {
    const owned = createSpaceClientForPlatform({ space: spaceId, getAccess: owner.getAccess, baseUrl: apiBaseURL }, { syncUrl: import.meta.env.VITE_CHALK_SYNC_URL?.trim() || undefined });
    const pagehide = (event: PageTransitionEvent) => {
      if (!event.persisted) owner.saveReload(owned.getSnapshot());
    };
    const unsubscribe = owned.subscribe(() => owner.observe(owned.getSnapshot()));
    window.addEventListener("pagehide", pagehide);
    setClient(owned);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", pagehide);
      void owned
        .leave()
        .then(() => owner.clearReload())
        .catch(() => undefined)
        .finally(() => owned.dispose());
    };
  }, [spaceId, owner, apiBaseURL]);
  const leave = () => {
    if (client?.getSnapshot().connection.lastError?.code !== "connection.leave_unconfirmed") owner.clearReload();
    void navigate({ to: "/dashboard/call/$spaceId", params: { spaceId } });
  };

  const error = failure ?? (state.kind === "error" ? state.error : null);
  if (error)
    return (
      <SiteRoot>
        <div className="dash">
          <div className="wrap">
            <ErrorPanel title="Couldn’t open the call" detail={errorMessage(error)} onRetry={failure ? retry : reload} />
          </div>
        </div>
      </SiteRoot>
    );
  if (!profile || state.kind !== "ready" || !client)
    return (
      <SiteRoot>
        <div className="dash">
          <div className="wrap">
            <p role="status">Opening your call…</p>
          </div>
        </div>
      </SiteRoot>
    );
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {startError ? (
        <p role="alert" className="absolute inset-x-6 bottom-6 z-[80] text-center">
          {startError}
        </p>
      ) : null}
      <OwnerCallSurface
        client={client}
        owner={owner}
        baseURL={apiBaseURL}
        onStartNewCall={() => {
          if (startingCall.current) return;
          startingCall.current = true;
          owner.clearReload();
          setStartError("Starting a new call…");
          void act("home", { action: "create-call", admission: "knock", idempotencyKey: startKey.current })
            .then(({ call }) => navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id } }))
            .catch(() => setStartError("Couldn’t start a new call. Try again."))
            .finally(() => {
              startingCall.current = false;
            });
        }}
        inviteLink={state.data.inviteUrl}
        spaceName={state.data.call.name}
        displayName={profile.name}
        theme={{ colorScheme: theme }}
        onColorSchemeChange={setTheme}
        onLeft={() => {
          if (client.getSnapshot().connection.episodeEnded) owner.clearReload();
          else leave();
        }}
        onEpisodeEnded={owner.clearReload}
        onHome={() => {
          owner.clearReload();
          void navigate({ to: "/dashboard" });
        }}
      />
    </div>
  );
}

function OwnerCallSurface({
  client,
  owner,
  baseURL,
  onStartNewCall,
  ...props
}: Omit<React.ComponentProps<typeof Chalk>, "client" | "space" | "getAccess"> & { readonly client: SpaceClient; readonly owner: ReturnType<typeof ownerAccess>; readonly baseURL: string; readonly onStartNewCall: () => void }) {
  const access = useSyncExternalStore(owner.subscribe, owner.reportAccess, owner.reportAccess);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const [extension, setExtension] = useState<"idle" | "pending" | "failed">("idle");
  const intent = useRef<{ deadline: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const deadline = connection.episode?.deadline;
  const ceiling = owner.deadlineCeiling();
  const atCeiling = !!(deadline && ceiling && Date.parse(deadline) >= Date.parse(ceiling));
  useEffect(() => {
    setExtension("idle");
    intent.current = null;
    inFlight.current = false;
  }, [deadline]);
  useEffect(() => {
    if (extension !== "pending") return;
    const timer = window.setTimeout(() => {
      inFlight.current = false;
      setExtension("failed");
    }, 30000);
    return () => window.clearTimeout(timer);
  }, [extension]);
  const extend = async () => {
    if (inFlight.current || !deadline || !ceiling || !access || atCeiling) return;
    inFlight.current = true;
    const request = intent.current ?? { deadline: new Date(Math.min(Date.parse(deadline) + 1800000, Date.parse(ceiling))).toISOString(), key: intentKey() };
    intent.current = request;
    setExtension("pending");
    try {
      await act("call", { action: "extend-call", spaceId: access.subject.space_id, episodeId: access.subject.episode_id, deadline: request.deadline, idempotencyKey: request.key });
    } catch {
      setExtension("failed");
      inFlight.current = false;
    }
  };
  const tenantId = access?.subject.tenant_id;
  const reportsAvailable = useProblemReports(baseURL, tenantId);
  const reportExpired = useReportCredentialExpired(access ? Date.parse(access.media.expires_at) : undefined);
  const onReportProblem = useMemo(() => problemReporter({ baseURL, tenantId, mediaProof: owner.reportCredential, connection: () => client.getSnapshot().connection }), [baseURL, tenantId, owner, client]);
  if (connection.status === "failed" && connection.lastError?.code === "access.invalid")
    return (
      <SiteRoot>
        <div className="dash">
          <div className="wrap">
            <ErrorPanel title="Refresh to rejoin the call" detail="Access to this call was rejected. Refresh the page to rejoin." />
            <button type="button" className="btn primary" onClick={() => window.location.reload()}>
              Reload page
            </button>
            <button type="button" className="btn sec" onClick={props.onHome}>
              Home
            </button>
          </div>
        </div>
      </SiteRoot>
    );
  return (
    <Chalk
      {...props}
      client={client}
      timeLimit={{
        message: atCeiling ? "This is the last extension. Calls can last up to 24 hours." : extension === "pending" ? "Adding time…" : extension === "failed" ? "Couldn’t add time. Try again." : "Need more time?",
        action: deadline && ceiling && !atCeiling && extension !== "pending" ? { label: "Add 30 min", onClick: () => void extend() } : undefined,
        endAction: { label: "Start a new call", onClick: onStartNewCall },
      }}
      onReportProblem={reportsAvailable ? onReportProblem : undefined}
      reportUnavailableReason={reportExpired ? reportCredentialExpiredReason : undefined}
    />
  );
}
