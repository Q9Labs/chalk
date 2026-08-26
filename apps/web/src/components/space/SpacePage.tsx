import { Chalk, Entrance, type EntranceSettings } from "@q9labsai/chalk-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { useEpisodeDiagnosticsAvailability } from "../../features/episode-debugger/EpisodeDiagnosticsDeveloperLink";
import { createPreparedPublicSpace, createPublicInviteClient, joinDashboardSpace, type AccountSpaceCredential, type PublicSpaceCredential, type SpaceAccessCleanupOptions, type PreparedPublicSpace, type PublicInviteClient } from "../../lib/chalk-access";
import { listAllAccountTenants, listSpaces } from "../../lib/dashboard-api";
import { canonicalSpaceInviteLink, clearDashboardSpaceEntry, hasDashboardSpaceEntry, spaceInviteToken, verifiedSpaceInviteLink } from "../../lib/named-space-route";
import { createLocalSpaceClient, createLocalSpaceRelease } from "../../lib/local-space-client";
import { useWebTelemetry } from "../../lib/web-telemetry-context";

const neutralSpaceError = "This Space is unavailable. Please check the invite link and try again.";

export function SpacePage({ slug, navigatePublicSpace = replacePublicSpaceHistory }: { readonly slug?: string; readonly navigatePublicSpace?: (canonicalSlug: string, inviteLink: string) => Promise<void> } = {}) {
  const { journey, telemetry } = useWebTelemetry();
  const client = useMemo(() => createPublicInviteClient(journey), [journey]);
  const initialDisplayName = useMemo(() => new URLSearchParams(globalThis.location?.search ?? "").get("name") ?? "", []);
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [entranceSettings, setEntranceSettings] = useState<EntranceSettings | null>(null);
  const [spaceAccess, setSpaceAccess] = useState<JoinedSpaceAccess | null>(null);
  const [pending, setPending] = useState<PendingArrival | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const active = useRef(true);
  const pendingRef = useRef<PendingArrival | null>(null);
  const cleanupPromise = useRef<Promise<void> | undefined>(undefined);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const arrival = pendingRef.current;
      if (arrival?.arrival.arrival_handle) void client.leaveSpacePublicInviteArrival(arrival.arrival.arrival_handle).catch(() => undefined);
    };
  }, [client]);

  const complete = useCallback(
    (prepared: SpaceEntryAccess, inviteLink: string | undefined, spaceName: string) => {
      if (!active.current) {
        void prepared.finish().catch(() => undefined);
        return;
      }
      try {
        telemetry.configureApiBaseURL(prepared.credential.apiBaseURL);
      } catch (cause) {
        void prepared.finish().catch(() => undefined);
        throw cause;
      }
      pendingRef.current = null;
      setPending(null);
      setSpaceAccess({ prepared, inviteLink, spaceName });
    },
    [telemetry],
  );

  const start = useCallback(
    (settings: EntranceSettings = { displayName, microphone: true, camera: true }) => {
      const normalizedDisplayName = settings.displayName.trim();
      const inviteToken = spaceInviteToken();
      if (!normalizedDisplayName || spaceAccess || pending || preparing) return;
      setDisplayName(normalizedDisplayName);
      setEntranceSettings(settings);
      const accountEntry = Boolean(slug && !inviteToken && hasDashboardSpaceEntry());
      if (slug && !inviteToken && !accountEntry) {
        setError(neutralSpaceError);
        return;
      }
      setError(null);
      setPreparing(true);
      const preparation = accountEntry ? prepareDashboardSpace(slug!, normalizedDisplayName, journey) : arrive(client, normalizedDisplayName, slug, inviteToken);
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
          if (arrival.state === "pending") {
            const nextPending = { arrival, inviteLink, spaceName } satisfies PendingArrival;
            pendingRef.current = nextPending;
            setPending(nextPending);
            return;
          }
          if (arrival.state !== "admitted") throw new Error(neutralSpaceError);
          const prepared = preparePublicSpace(client, arrival, normalizedDisplayName);
          complete(prepared, inviteLink, spaceName);
        })
        .catch((cause: unknown) => {
          if (active.current) setError(neutralMessage(cause));
        })
        .finally(() => {
          if (active.current) setPreparing(false);
        });
    },
    [client, complete, displayName, navigatePublicSpace, pending, preparing, slug, spaceAccess],
  );

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
        if (arrival.state !== "admitted") throw new Error(neutralSpaceError);
        const resumed = arrival.access ? arrival : await resumePendingArrival(client, pending, displayName);
        const prepared = preparePublicSpace(client, resumed, displayName);
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
      cleanupPromise.current = attempt;
      return attempt;
    },
    [spaceAccess],
  );

  if (spaceAccess) {
    const settings = entranceSettings ?? { displayName: displayName.trim(), microphone: true, camera: true };
    return (
      <LocalSpace
        credential={spaceAccess.prepared.credential}
        displayName={settings.displayName}
        defaults={{ microphone: settings.microphone, camera: settings.camera }}
        deviceSelection={settings}
        getAccess={spaceAccess.prepared.getAccess}
        connectionAccess={spaceAccess.prepared.connectionAccess}
        inviteLink={spaceAccess.inviteLink}
        journey={journey}
        onFinish={finish}
        spaceName={spaceAccess.spaceName}
        spaceDescription={spaceAccess.prepared.spaceDescription}
      />
    );
  }

  if (pending) return <SpaceArrival displayName={displayName} error={error} pending preparing={preparing} onCancel={cancel} onDisplayNameChange={setDisplayName} onEnter={() => start()} />;
  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      <Entrance spaceName={slug ?? "Space"} defaultDisplayName={displayName} defaults={{ microphone: true, camera: true }} joining={preparing} error={error ?? undefined} onJoin={start} />
    </main>
  );
}

type JoinedSpaceAccess = {
  readonly prepared: SpaceEntryAccess;
  readonly inviteLink?: string;
  readonly spaceName: string;
};

type SpaceEntryAccess = Pick<PreparedPublicSpace, "credential" | "getAccess"> & {
  readonly connectionAccess?: PreparedPublicSpace["connectionAccess"];
  readonly spaceDescription?: string;
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
};
type DashboardPreparation = { readonly kind: "dashboard"; readonly access: SpaceEntryAccess; readonly inviteLink?: string; readonly spaceName: string };

async function arrive(client: PublicInviteClient, displayName: string, slug: string | undefined, inviteToken: string | undefined): Promise<PublicPreparation> {
  if (inviteToken) {
    const arrival = await client.arriveBySpacePublicInvite(inviteToken, displayName);
    const verifiedSlug = arrival.space?.slug ?? slug;
    if (!verifiedSlug) throw new Error(neutralSpaceError);
    const inviteLink = canonicalSpaceInviteLink(verifiedSlug, inviteToken);
    return { kind: "public", arrival, canonicalSlug: verifiedSlug, inviteLink, spaceName: arrival.space?.name ?? verifiedSlug };
  }

  const created = await client.createPublicSpace(displayName);
  const inviteLink = verifiedSpaceInviteLink(created.space.slug, created.invite_link);
  return { kind: "public", arrival: created.arrival, canonicalSlug: created.space.slug, inviteLink, spaceName: created.space.name };
}

async function releasePublicPreparation(client: PublicInviteClient, preparation: PublicPreparation): Promise<void> {
  const arrivalHandle = preparation.arrival.arrival_handle;
  if (arrivalHandle) await client.leaveSpacePublicInviteArrival(arrivalHandle);
}

function preparePublicSpace(client: PublicInviteClient, arrival: PublicPreparation["arrival"], displayName: string): PreparedPublicSpace {
  return createPreparedPublicSpace(client, arrival, { reenter: () => reenterPublicSpace(client, displayName) });
}

async function reenterPublicSpace(client: PublicInviteClient, displayName: string): Promise<PublicPreparation["arrival"]> {
  const inviteToken = spaceInviteToken();
  if (!inviteToken) throw new Error(neutralSpaceError);
  let arrival = await client.arriveBySpacePublicInvite(inviteToken, displayName.trim());
  while (arrival.state === "pending") {
    const arrivalHandle = arrival.arrival_handle;
    if (!arrivalHandle) throw new Error(neutralSpaceError);
    await new Promise((resolve) => globalThis.setTimeout(resolve, retryDelay(arrival.retry_after)));
    arrival = await client.getSpacePublicInviteArrival(arrivalHandle);
  }
  if (arrival.state !== "admitted") throw new Error(neutralSpaceError);
  if (arrival.access) return arrival;
  return resumePendingArrival(client, { arrival, inviteLink: "", spaceName: arrival.space?.name ?? "Space" }, displayName);
}

async function replacePublicSpaceHistory(_canonicalSlug: string, inviteLink: string): Promise<void> {
  globalThis.history?.replaceState(globalThis.history.state, "", inviteLink);
}

async function prepareDashboardSpace(slug: string, displayName: string, journey: ReturnType<typeof useWebTelemetry>["journey"]): Promise<DashboardPreparation> {
  const tenantID = await resolveTenantID();
  if (!tenantID) throw new Error(neutralSpaceError);
  const [access, spaceDescription] = await Promise.all([joinDashboardSpace(tenantID, slug, displayName, journey), findSpaceDescription(tenantID, slug).catch(() => undefined)]);
  clearDashboardSpaceEntry();
  return { kind: "dashboard", access: { credential: access.credential, getAccess: access.getAccess, spaceDescription, finish: access.leave }, inviteLink: access.inviteLink, spaceName: slug };
}

async function findSpaceDescription(tenantID: string, slug: string): Promise<string | undefined> {
  let cursor: string | undefined;
  do {
    const page = await listSpaces({ tenantID, cursor, pageSize: 100 });
    const space = page.spaces.find((candidate) => candidate.slug === slug);
    if (space) return descriptionFromMetadata(space.metadata);
    cursor = page.pagination.has_more ? (page.pagination.next_cursor ?? undefined) : undefined;
  } while (cursor);
  return undefined;
}

function descriptionFromMetadata(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null) return undefined;
  const value = Reflect.get(metadata, "description");
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

async function resolveTenantID(): Promise<string> {
  try {
    const hint = globalThis.localStorage?.getItem("chalk.tenant-hint")?.trim();
    if (hint) return hint;
  } catch {
    // Storage is an optimization; the account list remains authoritative.
  }
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

function retryDelay(retryAfter: number | undefined): number {
  if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter) || retryAfter < 0) return 1_000;
  return Math.min(Math.max(retryAfter * 1_000, 250), 30_000);
}

async function resumePendingArrival(client: PublicInviteClient, pending: PendingArrival, displayName: string): Promise<Awaited<ReturnType<PublicInviteClient["arriveBySpacePublicInvite"]>>> {
  const inviteToken = spaceInviteToken();
  const arrivalHandle = pending.arrival.arrival_handle;
  if (!inviteToken || !arrivalHandle) throw new Error(neutralSpaceError);
  return client.arriveBySpacePublicInvite(inviteToken, displayName.trim(), { arrivalHandle });
}

function neutralMessage(_cause: unknown): string {
  return neutralSpaceError;
}

function LocalSpace({
  credential,
  displayName,
  defaults,
  deviceSelection,
  getAccess,
  connectionAccess,
  inviteLink,
  journey,
  onFinish,
  spaceName,
  spaceDescription,
}: {
  readonly credential: PublicSpaceCredential | AccountSpaceCredential;
  readonly displayName: string;
  readonly defaults: { readonly microphone: boolean; readonly camera: boolean };
  readonly deviceSelection?: Pick<EntranceSettings, "audioInputDeviceId" | "videoInputDeviceId" | "audioOutputDeviceId">;
  readonly getAccess: PreparedPublicSpace["getAccess"];
  readonly connectionAccess?: PreparedPublicSpace["connectionAccess"];
  readonly inviteLink?: string;
  readonly journey: ReturnType<typeof useWebTelemetry>["journey"];
  readonly onFinish: (options?: SpaceAccessCleanupOptions) => Promise<void>;
  readonly spaceName: string;
  readonly spaceDescription?: string;
}) {
  const client = useMemo(() => {
    const nextClient = createLocalSpaceClient({ credential, getAccess, connectionAccess, journey });
    selectEntranceDevices(nextClient, deviceSelection, journey);
    return nextClient;
  }, [connectionAccess, credential, deviceSelection, getAccess, journey]);
  const release = useMemo(() => createLocalSpaceRelease(client, () => onFinish()), [client, onFinish]);
  const episodeID = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot).connection.episode?.id;
  const diagnostics = useEpisodeDiagnosticsAvailability({ diagnosticReference: episodeID ? `chalk.episode:${episodeID}` : undefined });
  const pendingRelease = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(undefined);
  const openDiagnostics = useCallback(() => {
    if (diagnostics.path) globalThis.open(diagnostics.path, "_blank", "noopener");
  }, [diagnostics.path]);
  const releaseFromLifecycle = useCallback(() => {
    void release().catch(() => undefined);
  }, [release]);

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
      if (!event.persisted) void onFinish({ keepalive: true }).catch(() => undefined);
    };
    globalThis.addEventListener("pagehide", releaseOnPageHide);
    return () => globalThis.removeEventListener("pagehide", releaseOnPageHide);
  }, [onFinish]);

  return (
    <main className="h-dvh min-h-0 w-full overflow-hidden">
      <Chalk
        client={client}
        entrance={false}
        displayName={displayName}
        defaults={defaults}
        logoUrl="/brand/chalk/chalk-logo.svg"
        spaceName={spaceName}
        spaceDescription={spaceDescription}
        inviteLink={inviteLink}
        diagnosticReference={diagnostics.reference}
        onEpisodeEnded={releaseFromLifecycle}
        onOpenDiagnostics={diagnostics.path ? openDiagnostics : undefined}
      />
    </main>
  );
}

function selectEntranceDevices(client: ReturnType<typeof createLocalSpaceClient>, selection: Pick<EntranceSettings, "audioInputDeviceId" | "videoInputDeviceId" | "audioOutputDeviceId"> | undefined, journey: ReturnType<typeof useWebTelemetry>["journey"]): void {
  const audioInputDeviceId = selection?.audioInputDeviceId;
  const videoInputDeviceId = selection?.videoInputDeviceId;
  const audioOutputDeviceId = selection?.audioOutputDeviceId;
  const requested = [
    audioInputDeviceId ? { kind: "microphone", select: () => client.media.selectMicrophone(audioInputDeviceId) } : undefined,
    videoInputDeviceId ? { kind: "camera", select: () => client.media.selectCamera(videoInputDeviceId) } : undefined,
    audioOutputDeviceId ? { kind: "speaker", select: () => client.media.selectSpeaker(audioOutputDeviceId) } : undefined,
  ].filter((item): item is { readonly kind: "microphone" | "camera" | "speaker"; readonly select: () => Promise<void> } => item !== undefined);
  for (const item of requested) {
    void item.select().catch(() => {
      journey.recordDiagnostic({ category: "device", code: "space.entrance_device_selection_failed", phase: "media", state: "failed", attributes: { device_kind: item.kind } });
    });
  }
}

function SpaceArrival({
  displayName,
  error,
  pending,
  preparing,
  onCancel,
  onDisplayNameChange,
  onEnter,
}: {
  readonly displayName: string;
  readonly error: string | null;
  readonly pending: boolean;
  readonly preparing: boolean;
  readonly onCancel: () => Promise<void>;
  readonly onDisplayNameChange: (displayName: string) => void;
  readonly onEnter: () => void;
}) {
  return (
    <main className="grid min-h-dvh place-items-center bg-[#f7f6f2] p-6 text-center text-[#0c0e12]">
      <section className="w-full max-w-md rounded-lg border border-[#deddd7] bg-white p-6 text-left shadow-[0_22px_54px_rgba(12,14,18,0.08)]">
        <h1 className="text-2xl font-semibold">{pending ? "Waiting to enter" : "Enter this Space"}</h1>
        <p className="mt-2 text-sm leading-6 text-[#555b65]">{pending ? "The host must approve your arrival." : "Choose the name other Participants will see."}</p>
        {!pending ? (
          <>
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
          </>
        ) : null}
        {error ? (
          <p role="alert" className="mt-4 text-sm text-[#b94c4c]">
            {error}
          </p>
        ) : null}
        {pending ? (
          <button type="button" className="mt-6 h-11 w-full rounded-md border border-[#deddd7] text-sm font-medium" onClick={() => void onCancel()} disabled={preparing}>
            Cancel
          </button>
        ) : (
          <button type="button" className="mt-6 h-11 w-full rounded-md bg-[#0c0e12] text-sm font-medium text-white disabled:opacity-50" onClick={onEnter} disabled={!displayName.trim() || preparing}>
            {preparing ? "Preparing…" : "Continue"}
          </button>
        )}
      </section>
    </main>
  );
}
