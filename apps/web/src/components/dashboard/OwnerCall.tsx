import type { SpaceClient } from "@q9labsai/chalk-client";
import { Chalk } from "@q9labsai/chalk-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { act, errorMessage, intentKey, readPage } from "../../lib/dashboard/client";
import { SiteRoot, useSiteTheme } from "../site/theme";
import { useLoad, useSession } from "./AppShell";
import { ErrorPanel } from "./kit";
import { createCallAction, readNewCallLanguage } from "./transcript-languages";

import { problemReporter, reportCredentialExpiredReason, useProblemReports, useReportCredentialExpired } from "../../lib/problem-reports";
import { publicAPIBaseURL, webSpaceCredential } from "../../lib/chalk-access";
import { createLocalSpaceClient } from "../../lib/local-space-client";
import { ownerAccess } from "./owner-seat";

type Owner = ReturnType<typeof ownerAccess>;

function DashScreen({ children }: { readonly children: ReactNode }) {
  return (
    <SiteRoot>
      <div className="dash">
        <div className="wrap">{children}</div>
      </div>
    </SiteRoot>
  );
}

/** The Space client this screen owns: created with the owner's access, saved for reload on pagehide, closed on unmount. */
function useOwnedSpaceClient(spaceId: string, owner: Owner): SpaceClient | null {
  const [client, setClient] = useState<SpaceClient | null>(null);
  useEffect(() => {
    const owned = createLocalSpaceClient({ credential: webSpaceCredential(spaceId), getAccess: owner.getAccess });
    const pagehide = (event: PageTransitionEvent) => {
      if (!event.persisted) owner.saveReload(owned.getSnapshot());
    };
    const unsubscribe = owned.subscribe(() => owner.observe(owned.getSnapshot()));
    window.addEventListener("pagehide", pagehide);
    setClient(owned);
    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", pagehide);
      void owned.close().then(() => owner.afterClose(owned.getSnapshot().connection));
    };
  }, [spaceId, owner]);
  return client;
}

/** Starts a new call from the ended one, once per click, under one idempotency key per Space. */
function useStartNewCall(spaceId: string, owner: Owner) {
  const navigate = useNavigate();
  const startKey = useRef(intentKey());
  const startingCall = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  useEffect(() => {
    startKey.current = intentKey();
    startingCall.current = false;
    setStartError(null);
  }, [spaceId]);
  const startNewCall = () => {
    if (startingCall.current) return;
    startingCall.current = true;
    owner.clearReload();
    setStartError("Starting a new call…");
    void act("home", createCallAction(startKey.current, readNewCallLanguage()))
      .then(({ call }) => navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id } }))
      .catch(() => setStartError("Couldn’t start a new call. Try again."))
      .finally(() => {
        startingCall.current = false;
      });
  };
  return { startError, startNewCall };
}

/** The call screen for the call's owner, through the React SDK's own call UI. */
export function OwnerCall({ spaceId }: { readonly spaceId: string }) {
  const { profile, failure, retry } = useSession();
  const { state, reload } = useLoad(() => readPage("call", { spaceId }), `call:${spaceId}`);
  const { theme, setTheme } = useSiteTheme();
  const navigate = useNavigate();
  const owner = useMemo(() => ownerAccess(spaceId, profile?.id ?? ""), [spaceId, profile?.id]);
  const client = useOwnedSpaceClient(spaceId, owner);
  const { startError, startNewCall } = useStartNewCall(spaceId, owner);

  const error = failure ?? (state.kind === "error" ? state.error : null);
  if (error)
    return (
      <DashScreen>
        <ErrorPanel title="Couldn’t open the call" detail={errorMessage(error)} onRetry={failure ? retry : reload} />
      </DashScreen>
    );
  if (!profile || state.kind !== "ready" || !client)
    return (
      <DashScreen>
        <p role="status">Opening your call…</p>
      </DashScreen>
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
        baseURL={publicAPIBaseURL()}
        onStartNewCall={startNewCall}
        inviteLink={state.data.inviteUrl}
        spaceName={state.data.call.name}
        displayName={profile.name}
        theme={{ colorScheme: theme }}
        onColorSchemeChange={setTheme}
        onLeft={() => {
          if (client.getSnapshot().connection.episodeEnded) owner.clearReload();
          else void navigate({ to: "/dashboard/call/$spaceId", params: { spaceId } });
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

type TimeLimitExtension = { readonly message: string; readonly action: { readonly label: string; readonly onClick: () => void } | undefined };

/** The "Add 30 min" offer: one request per deadline, retried with the same key until the deadline moves, capped at the Episode's ceiling. */
function useTimeLimitExtension(owner: Owner, access: ReturnType<Owner["reportAccess"]>, deadline: string | undefined): TimeLimitExtension {
  const [extension, setExtension] = useState<"idle" | "pending" | "failed">("idle");
  const intent = useRef<{ deadline: string; key: string } | null>(null);
  const inFlight = useRef(false);
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
  const message = atCeiling ? "This is the last extension. Calls can last up to 24 hours." : extension === "pending" ? "Adding time…" : extension === "failed" ? "Couldn’t add time. Try again." : "Need more time?";
  return { message, action: deadline && ceiling && !atCeiling && extension !== "pending" ? { label: "Add 30 min", onClick: () => void extend() } : undefined };
}

function OwnerCallSurface({ client, owner, baseURL, onStartNewCall, ...props }: Omit<React.ComponentProps<typeof Chalk>, "client" | "space" | "getAccess"> & { readonly client: SpaceClient; readonly owner: Owner; readonly baseURL: string; readonly onStartNewCall: () => void }) {
  const access = useSyncExternalStore(owner.subscribe, owner.reportAccess, owner.reportAccess);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const timeLimit = useTimeLimitExtension(owner, access, connection.episode?.deadline);
  const tenantId = access?.subject.tenant_id;
  const reportsAvailable = useProblemReports(baseURL, tenantId);
  const reportExpired = useReportCredentialExpired(access ? Date.parse(access.media.expires_at) : undefined);
  const onReportProblem = useMemo(() => problemReporter({ baseURL, tenantId, mediaProof: owner.reportCredential, connection: () => client.getSnapshot().connection }), [baseURL, tenantId, owner, client]);
  if (connection.status === "failed" && connection.lastError?.code === "access.invalid")
    return (
      <DashScreen>
        <ErrorPanel title="Refresh to rejoin the call" detail="Access to this call was rejected. Refresh the page to rejoin." />
        <button type="button" className="btn pri" onClick={() => window.location.reload()}>
          Reload page
        </button>
        <button type="button" className="btn sec" onClick={props.onHome}>
          Home
        </button>
      </DashScreen>
    );
  return <Chalk {...props} client={client} timeLimit={{ ...timeLimit, endAction: { label: "Start a new call", onClick: onStartNewCall } }} onReportProblem={reportsAvailable ? onReportProblem : undefined} reportUnavailableReason={reportExpired ? reportCredentialExpiredReason : undefined} />;
}
