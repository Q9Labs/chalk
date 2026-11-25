import type { SpaceClient } from "@q9labsai/chalk-client";
import { CallLimbo, Chalk } from "@q9labsai/chalk-react";
import { callAnnotation } from "../../lib/screen-annotation";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { errorMessage, readPage } from "../../lib/dashboard/client";
import { SiteRoot, useSiteTheme } from "../site/theme";
import { useLoad, useSession } from "./use-dashboard";
import { ErrorPanel } from "./kit";
import { newCallIntent, startCall } from "./language-choice";
import { callLinkShown, joiningCallName } from "./join-call";

import { reportCredentialExpiredReason, useProblemReports, useReportCredentialExpired } from "../../lib/problem-reports";
import { problemReporter } from "../../lib/send-problem-report";
import { publicAPIBaseURL, webSpaceCredential } from "../../lib/chalk-access";
import { createLocalSpaceClient } from "../../lib/local-space-client";
import { ownerAccess } from "./owner-seat";
const EXTENSION_MINUTES = 30;

/** The call screen for the call's owner, through the React SDK's own call UI. */
export function OwnerCall({ spaceId }: { readonly spaceId: string }) {
  const { profile, failure, retry } = useSession();
  const { state, reload } = useLoad(() => readPage("call", { spaceId }), `call:${spaceId}`);
  const { theme, setTheme } = useSiteTheme();
  const navigate = useNavigate();
  const apiBaseURL = publicAPIBaseURL();
  const owner = useMemo(() => ownerAccess(spaceId, profile?.id ?? ""), [spaceId, profile?.id]);
  const [client, setClient] = useState<SpaceClient | null>(null);
  const startKey = useRef(newCallIntent());
  const startingCall = useRef(false);
  const [startError, setStartError] = useState<string | null>(null);
  useEffect(() => {
    startKey.current = newCallIntent();
    startingCall.current = false;
    setStartError(null);
  }, [spaceId]);
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
  const leave = () => {
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
  if (!profile || state.kind !== "ready" || !client) {
    // The same stand-in call and card that Chalk shows while it joins, so opening and joining read as one step.
    const callName = state.kind === "ready" ? state.data.call.name : joiningCallName(spaceId);
    return (
      <div style={{ position: "absolute", inset: 0 }}>
        <CallLimbo theme={{ colorScheme: theme }} spaceName={callName ?? "Your call"} message={`Joining ${callName ?? "your call"}…`} />
      </div>
    );
  }
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
        accountId={profile?.id}
        baseURL={apiBaseURL}
        onStartNewCall={() => {
          if (startingCall.current) return;
          startingCall.current = true;
          owner.clearReload();
          setStartError("Starting a new call…");
          void startCall(startKey.current)
            .then(({ call }) => navigate({ to: "/dashboard/call/$spaceId/join", params: { spaceId: call.id } }))
            .catch(() => setStartError("Couldn’t start a new call. Try again."))
            .finally(() => {
              startingCall.current = false;
            });
        }}
        inviteLink={state.data.inviteUrl}
        {...(callLinkShown(spaceId) ? { callLinkOpen: false } : {})}
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
  accountId,
  baseURL,
  onStartNewCall,
  ...props
}: Omit<React.ComponentProps<typeof Chalk>, "client" | "space" | "getAccess"> & { readonly client: SpaceClient; readonly owner: ReturnType<typeof ownerAccess>; readonly accountId?: string; readonly baseURL: string; readonly onStartNewCall: () => void }) {
  const access = useSyncExternalStore(owner.subscribe, owner.reportAccess, owner.reportAccess);
  const connection = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection;
  const [extension, setExtension] = useState<"idle" | "pending" | "failed">("idle");
  const deadline = connection.episode?.deadline;
  const ceiling = owner.deadlineCeiling();
  const atCeiling = !!(deadline && ceiling && Date.parse(deadline) >= Date.parse(ceiling));
  useEffect(() => {
    setExtension("idle");
  }, [deadline]);
  useEffect(() => {
    if (extension !== "pending") return;
    const timer = window.setTimeout(() => setExtension("failed"), 30000);
    return () => window.clearTimeout(timer);
  }, [extension]);
  const extend = async () => {
    if (extension === "pending" || !deadline || atCeiling) return;
    setExtension("pending");
    try {
      await client.extendEpisode(EXTENSION_MINUTES);
    } catch {
      setExtension("failed");
    }
  };
  const tenantId = access?.subject.tenant_id;
  const reportsAvailable = useProblemReports(baseURL, tenantId);
  const reportExpired = useReportCredentialExpired(access ? Date.parse(access.media.expires_at) : undefined);
  const onReportProblem = useMemo(() => problemReporter({ baseURL, tenantId, mediaProof: owner.reportCredential, connection: () => client.getSnapshot().connection, telemetry: client.telemetry }), [baseURL, tenantId, owner, client]);
  const annotation = useMemo(
    () =>
      callAnnotation({
        apiBaseUrl: baseURL,
        tenantId,
        accountId,
        mediaProof: owner.reportCredential,
        client,
      }),
    [baseURL, tenantId, accountId, owner, client],
  );
  if (connection.status === "failed" && connection.lastError?.code === "access.invalid")
    return (
      <SiteRoot>
        <div className="dash">
          <div className="wrap">
            <ErrorPanel title="Refresh to rejoin the call" detail="Access to this call was rejected. Refresh the page to rejoin." />
            <button type="button" className="btn pri" onClick={() => window.location.reload()}>
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
      screenAnnotation={annotation}
      {...props}
      client={client}
      timeLimit={{
        message: atCeiling ? "This is the longest this call can run." : extension === "pending" ? "Adding time…" : extension === "failed" ? "Couldn’t add time. Try again." : "Need more time?",
        action: deadline && ceiling && !atCeiling && extension !== "pending" ? { label: `Add ${EXTENSION_MINUTES} min`, onClick: () => void extend() } : undefined,
        endAction: { label: "Start a new call", onClick: onStartNewCall },
      }}
      onReportProblem={reportsAvailable ? onReportProblem : undefined}
      reportUnavailableReason={reportExpired ? reportCredentialExpiredReason : undefined}
    />
  );
}
