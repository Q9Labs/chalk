import { Chalk } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cleanupParticipantCredential, createAccessGrantProvider, createParticipantCredential, isTerminalParticipantCredentialCleanupError, joinDashboardSpace, type DashboardSpaceAccess, type ParticipantCredential, type ParticipantCredentialCleanupOptions } from "../../lib/chalk-access";
import { listAllAccountTenants } from "../../lib/dashboard-api";
import { createLocalSpaceClient, createLocalSpaceRelease } from "../../lib/local-space-client";
import { useWebTelemetry } from "../../lib/web-telemetry-context";

export function SpacePage() {
  const { journey, telemetry } = useWebTelemetry();
  const initialDisplayName = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("name") ?? "", []);
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [credential, setCredential] = useState<ParticipantCredential | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const active = useRef(true);
  const cleanupPromise = useRef<Promise<void> | undefined>(undefined);
  const getAccess = useMemo(() => createAccessGrantProvider(journey), [journey]);

  const enter = useCallback(() => {
    const normalizedDisplayName = displayName.trim();
    if (!normalizedDisplayName || credential || preparing) return;
    setError(null);
    setPreparing(true);
    void createParticipantCredential(normalizedDisplayName, spaceInviteToken(), journey)
      .then((nextCredential) => {
        if (!active.current) {
          void cleanupParticipantCredential(journey).catch(() => undefined);
          return;
        }
        try {
          telemetry.configureApiBaseURL(nextCredential.apiBaseURL);
        } catch (cause) {
          void cleanupParticipantCredential(journey).catch(() => undefined);
          throw cause;
        }
        if (nextCredential.spaceInviteToken) setSpaceInviteToken(nextCredential.spaceInviteToken);
        setCredential(nextCredential);
      })
      .catch((cause: unknown) => {
        if (active.current) setError(cause instanceof Error ? cause.message : "Could not prepare this Space.");
      })
      .finally(() => {
        if (active.current) setPreparing(false);
      });
  }, [credential, displayName, journey, preparing, telemetry]);

  const finish = useCallback(
    (options: ParticipantCredentialCleanupOptions = {}) => {
      if (cleanupPromise.current) return cleanupPromise.current;
      const attempt = cleanupParticipantCredential(journey, options).then(
        () => {
          clearSpaceInviteToken();
        },
        (cause: unknown) => {
          if (isTerminalParticipantCredentialCleanupError(cause)) {
            clearSpaceInviteToken();
            return;
          }
          cleanupPromise.current = undefined;
          throw cause;
        },
      );
      cleanupPromise.current = attempt;
      return attempt;
    },
    [journey],
  );

  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );

  if (credential) {
    return <LocalSpace credential={credential} displayName={displayName.trim()} getAccess={getAccess} journey={journey} onFinish={finish} />;
  }

  return <SpaceArrival displayName={displayName} error={error} preparing={preparing} onDisplayNameChange={setDisplayName} onEnter={enter} />;
}

/** Account-bound Dashboard entry. The slug is the only browser route state. */
export function DashboardSpacePage({ slug }: { readonly slug: string }) {
  const { journey, telemetry } = useWebTelemetry();
  const [displayName, setDisplayName] = useState("");
  const [spaceAccess, setSpaceAccess] = useState<DashboardSpaceAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const active = useRef(true);
  const cleanupPromise = useRef<Promise<void> | undefined>(undefined);

  const enter = useCallback(() => {
    const normalized = displayName.trim();
    if (!normalized || spaceAccess || preparing) return;
    setPreparing(true);
    setError(null);
    void resolveTenantID()
      .then((tenantID) => {
        if (!tenantID) throw new Error("Select a Tenant in the Dashboard before entering this Space.");
        return joinDashboardSpace(tenantID, slug, normalized, journey);
      })
      .then((next) => {
        if (!active.current) {
          void next.leave().catch(() => undefined);
          return;
        }
        telemetry.configureApiBaseURL(next.credential.apiBaseURL);
        setSpaceAccess(next);
      })
      .catch((cause: unknown) => {
        if (active.current) setError(cause instanceof Error ? cause.message : "Could not join this Space.");
      })
      .finally(() => {
        if (active.current) setPreparing(false);
      });
  }, [displayName, journey, preparing, slug, spaceAccess, telemetry]);

  const finish = useCallback(
    (options: ParticipantCredentialCleanupOptions = {}) => {
      if (cleanupPromise.current) return cleanupPromise.current;
      const attempt =
        spaceAccess?.leave(options).catch((cause: unknown) => {
          cleanupPromise.current = undefined;
          throw cause;
        }) ?? Promise.resolve();
      cleanupPromise.current = attempt;
      return attempt;
    },
    [spaceAccess],
  );

  useEffect(
    () => () => {
      active.current = false;
    },
    [],
  );

  if (spaceAccess) return <LocalSpace credential={spaceAccess.credential} displayName={displayName.trim()} getAccess={spaceAccess.getAccess} connectionAccess={spaceAccess.connectionAccess} journey={journey} onFinish={finish} spaceName={slug} />;
  return <SpaceArrival displayName={displayName} error={error} preparing={preparing} onDisplayNameChange={setDisplayName} onEnter={enter} />;
}

function LocalSpace({
  credential,
  displayName,
  getAccess,
  connectionAccess,
  journey,
  onFinish,
  spaceName,
}: {
  readonly credential: ParticipantCredential | DashboardSpaceAccess["credential"];
  readonly displayName: string;
  readonly getAccess: ReturnType<typeof createAccessGrantProvider>;
  readonly connectionAccess?: DashboardSpaceAccess["connectionAccess"];
  readonly journey: ReturnType<typeof useWebTelemetry>["journey"];
  readonly onFinish: (options?: ParticipantCredentialCleanupOptions) => Promise<void>;
  readonly spaceName?: string;
}) {
  const client = useMemo(() => createLocalSpaceClient({ credential, getAccess, connectionAccess, journey }), [connectionAccess, credential, getAccess, journey]);
  const release = useMemo(() => createLocalSpaceRelease(client, () => onFinish()), [client, onFinish]);
  const releaseFromLifecycle = useCallback(() => {
    void release().catch(() => undefined);
  }, [release]);

  useEffect(
    () => () => {
      void release().catch(() => undefined);
    },
    [release],
  );

  useEffect(() => {
    const releaseOnPageHide = (event: PageTransitionEvent) => {
      if (!event.persisted) void onFinish({ keepalive: true }).catch(() => undefined);
    };
    globalThis.addEventListener("pagehide", releaseOnPageHide);
    return () => globalThis.removeEventListener("pagehide", releaseOnPageHide);
  }, [onFinish]);

  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      <Chalk client={client} entrance displayName={displayName} defaults={{ microphone: true, camera: true }} logoUrl="/brand/chalk/chalk-logo.svg" spaceName={spaceName ?? "Local Space"} inviteLink={globalThis.location?.href} onEpisodeEnded={releaseFromLifecycle} onLeft={releaseFromLifecycle} />
    </main>
  );
}

function tenantIDFromPage(): string {
  try {
    return globalThis.localStorage?.getItem("chalk.tenant-hint") ?? "";
  } catch {
    return "";
  }
}

async function resolveTenantID(): Promise<string> {
  const hint = tenantIDFromPage();
  if (hint) return hint;
  const tenants = await listAllAccountTenants();
  const tenantID = tenants[0]?.tenant.id ?? "";
  if (tenantID) {
    try {
      globalThis.localStorage?.setItem("chalk.tenant-hint", tenantID);
    } catch {
      // Storage is an optimization; the current request remains authoritative.
    }
  }
  return tenantID;
}

function SpaceArrival({ displayName, error, preparing, onDisplayNameChange, onEnter }: { readonly displayName: string; readonly error: string | null; readonly preparing: boolean; readonly onDisplayNameChange: (displayName: string) => void; readonly onEnter: () => void }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#f7f6f2] p-6 text-center text-[#0c0e12]">
      <section className="w-full max-w-md rounded-lg border border-[#deddd7] bg-white p-6 text-left shadow-[0_22px_54px_rgba(12,14,18,0.08)]">
        <h1 className="text-2xl font-semibold">Enter this Space</h1>
        <p className="mt-2 text-sm leading-6 text-[#555b65]">Choose the name other Participants will see.</p>
        <label className="mt-6 block text-sm font-medium" htmlFor="display-name">
          Your name
        </label>
        <input
          id="display-name"
          autoComplete="name"
          value={displayName}
          onChange={(event) => onDisplayNameChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onEnter();
          }}
          className="mt-2 h-11 w-full rounded-md border border-[#deddd7] px-3 text-sm outline-none focus-visible:border-[#74b7cf]"
          placeholder="Enter your name"
        />
        {error ? (
          <p role="alert" className="mt-4 text-sm text-[#b94c4c]">
            {error}
          </p>
        ) : null}
        <button type="button" onClick={onEnter} disabled={preparing || !displayName.trim()} aria-busy={preparing} className="mt-6 h-11 w-full rounded-md bg-[#315f72] px-4 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50">
          Continue
        </button>
      </section>
    </main>
  );
}

function spaceInviteToken(): string | undefined {
  const hash = globalThis.location?.hash;
  if (!hash) return undefined;
  return new URLSearchParams(hash.slice(1)).get("spaceInviteToken") ?? undefined;
}

function setSpaceInviteToken(value: string): void {
  if (!globalThis.location || !globalThis.history) return;
  const url = new URL(globalThis.location.href);
  url.hash = new URLSearchParams({ spaceInviteToken: value }).toString();
  globalThis.history.replaceState(globalThis.history.state, "", url);
}

function clearSpaceInviteToken(): void {
  if (!globalThis.location || !globalThis.history) return;
  const url = new URL(globalThis.location.href);
  url.hash = "";
  globalThis.history.replaceState(globalThis.history.state, "", url);
}
