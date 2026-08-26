import { createElement, useState, type ChangeEvent, type ReactNode } from "react";
import { vi } from "vitest";

function MockEntrance({
  defaultDisplayName = "",
  joining = false,
  error,
  onJoin,
}: {
  readonly defaultDisplayName?: string;
  readonly joining?: boolean;
  readonly error?: string;
  readonly onJoin: (settings: { readonly displayName: string; readonly microphone: boolean; readonly camera: boolean }) => void | Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(defaultDisplayName);
  const onDisplayNameChange = (event: ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value);
  return createElement(
    "main",
    null,
    createElement("label", { htmlFor: "mock-entrance-name" }, "Your name"),
    createElement("input", { id: "mock-entrance-name", "aria-label": "Your name", value: displayName, onChange: onDisplayNameChange }),
    error ? createElement("p", { role: "alert" }, error) : null,
    createElement("button", { type: "button", onClick: () => void onJoin({ displayName: displayName.trim(), microphone: true, camera: true }), disabled: joining || !displayName.trim() }, joining ? "Joining…" : "Continue"),
  );
}

const spacePageTestMocks = vi.hoisted(() => {
  const holder: { chalkProps?: Record<string, unknown> } = {};
  const journey = { headers: {}, recordDiagnostic: vi.fn(), recordHttpRequest: vi.fn() };
  const telemetry = { configureApiBaseURL: vi.fn() };
  const episodeID = "33333333-3333-4333-8333-333333333333";
  const diagnosticsReference = `chalk.episode:${episodeID}`;
  const diagnosticsPath = `/developer/episode-diagnostics/${encodeURIComponent(diagnosticsReference)}`;
  const clientSnapshot = { connection: { episode: { id: episodeID } } };
  const client = { getSnapshot: vi.fn(() => clientSnapshot), subscribe: vi.fn(() => () => undefined), leave: vi.fn(async () => undefined), dispose: vi.fn() };
  const getAccess = vi.fn();
  const connectionAccess = vi.fn();
  const finish = vi.fn(async () => undefined);
  const dashboardAccess = {
    credential: { apiBaseURL: "https://api.chalk.test", space: "space-1", access: { subject: {}, sync: { token: "sync" }, media: { token: "media" } }, participantGeneration: 3 },
    getAccess,
    connectionAccess,
    leave: finish,
    inviteLink: "/space/design-lab#spaceInviteToken=cspi1.account",
  };
  const publicClient = {
    createPublicSpace: vi.fn(),
    arriveBySpacePublicInvite: vi.fn(),
    getSpacePublicInviteArrival: vi.fn(),
    refreshSpacePublicInviteAccess: vi.fn(),
    leaveSpacePublicInviteArrival: vi.fn(async () => undefined),
  };
  const prepared = {
    arrival: undefined,
    credential: { apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", space: "design-lab" },
    getAccess,
    connectionAccess,
    finish,
  };
  return {
    holder,
    journey,
    telemetry,
    publicClient,
    dashboardAccess,
    prepared,
    client,
    getAccess,
    connectionAccess,
    finish,
    diagnosticsPath,
    diagnosticsReference,
    localStorage: { getItem: vi.fn(), setItem: vi.fn() },
    open: vi.fn(),
    useEpisodeDiagnosticsAvailability: vi.fn(
      () =>
        ({ path: diagnosticsPath, reference: diagnosticsReference, status: "available", supported: true, retry: vi.fn() }) satisfies {
          readonly path?: string;
          readonly reference?: string;
          readonly status: "available" | "checking" | "unavailable";
          readonly supported: boolean;
          readonly retry: () => void;
        },
    ),
    createPublicInviteClient: vi.fn(() => publicClient),
    createPreparedPublicSpace: vi.fn((_client: unknown, _arrival: unknown, _options?: { readonly reenter?: () => Promise<unknown> }) => prepared),
    joinDashboardSpace: vi.fn(() => dashboardAccess),
    listAllAccountTenants: vi.fn(async () => [{ tenant: { id: "tenant-1" } }]),
    listSpaces: vi.fn(async () => ({ spaces: [{ slug: "design-lab", metadata: { description: "A calm design review Space." } }], pagination: { page_size: 100, next_cursor: null, has_more: false } })),
    createLocalSpaceClient: vi.fn(() => client),
    createLocalSpaceRelease: vi.fn((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup)),
    Chalk: vi.fn((props: Record<string, unknown>) => {
      holder.chalkProps = props;
      return null;
    }),
  };
});

vi.mock("@q9labsai/chalk-react", () => ({ Chalk: getSpacePageTestMocks().Chalk, Entrance: MockEntrance }));
vi.mock("../lib/chalk-access", () => ({
  createPublicInviteClient: getSpacePageTestMocks().createPublicInviteClient,
  createPreparedPublicSpace: getSpacePageTestMocks().createPreparedPublicSpace,
  joinDashboardSpace: getSpacePageTestMocks().joinDashboardSpace,
}));
vi.mock("../lib/dashboard-api", () => ({ listAllAccountTenants: getSpacePageTestMocks().listAllAccountTenants, listSpaces: getSpacePageTestMocks().listSpaces }));
vi.mock("../lib/local-space-client", () => ({
  createLocalSpaceClient: getSpacePageTestMocks().createLocalSpaceClient,
  createLocalSpaceRelease: getSpacePageTestMocks().createLocalSpaceRelease,
}));
vi.mock("../lib/web-telemetry-context", () => ({
  WebTelemetryProvider: ({ children }: { readonly children: ReactNode }) => children,
  useWebTelemetry: () => ({ journey: getSpacePageTestMocks().journey, telemetry: getSpacePageTestMocks().telemetry }),
}));
vi.mock("../features/episode-debugger/EpisodeDiagnosticsDeveloperLink", () => ({ useEpisodeDiagnosticsAvailability: getSpacePageTestMocks().useEpisodeDiagnosticsAvailability }));

export function getSpacePageTestMocks(): typeof spacePageTestMocks {
  return spacePageTestMocks;
}

export const spacePageTestToken = "cspi1.test-capability";
export const spacePageTestArrival = {
  state: "admitted",
  arrival_handle: "arrival-11111111",
  identity: "guest",
  space: { admission_mode: "open", name: "Design Lab", slug: "design-lab" },
  access: { subject: {}, sync: { token: "sync" }, media: { token: "media" } },
};
export const spacePageTestCreated = {
  invite_link: `http://localhost:3000/space/created-space#spaceInviteToken=${spacePageTestToken}`,
  lifecycle_until: "2026-08-19T12:00:00Z",
  space: { admission_mode: "open", name: "Created Space", slug: "created-space" },
  arrival: spacePageTestArrival,
};

export function resetSpacePageTestMocks(): void {
  window.history.replaceState({}, "", "/space");
  vi.stubGlobal("localStorage", spacePageTestMocks.localStorage);
  vi.stubGlobal("open", spacePageTestMocks.open);
  spacePageTestMocks.holder.chalkProps = undefined;
  spacePageTestMocks.publicClient.createPublicSpace.mockReset().mockResolvedValue(spacePageTestCreated);
  spacePageTestMocks.publicClient.arriveBySpacePublicInvite.mockReset().mockResolvedValue(spacePageTestArrival);
  spacePageTestMocks.publicClient.getSpacePublicInviteArrival.mockReset().mockResolvedValue(spacePageTestArrival);
  spacePageTestMocks.publicClient.refreshSpacePublicInviteAccess.mockReset().mockResolvedValue(spacePageTestArrival.access);
  spacePageTestMocks.publicClient.leaveSpacePublicInviteArrival.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.createPublicInviteClient.mockClear();
  spacePageTestMocks.createPreparedPublicSpace.mockReset().mockReturnValue(spacePageTestMocks.prepared);
  spacePageTestMocks.joinDashboardSpace.mockReset().mockResolvedValue(spacePageTestMocks.dashboardAccess);
  spacePageTestMocks.listAllAccountTenants.mockReset().mockResolvedValue([{ tenant: { id: "tenant-1" } }]);
  spacePageTestMocks.listSpaces.mockReset().mockResolvedValue({ spaces: [{ slug: "design-lab", metadata: { description: "A calm design review Space." } }], pagination: { page_size: 100, next_cursor: null, has_more: false } });
  spacePageTestMocks.prepared.finish.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.createLocalSpaceClient.mockReset().mockReturnValue(spacePageTestMocks.client);
  spacePageTestMocks.createLocalSpaceRelease.mockReset().mockImplementation((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup));
  spacePageTestMocks.useEpisodeDiagnosticsAvailability.mockReset().mockReturnValue({ path: spacePageTestMocks.diagnosticsPath, reference: spacePageTestMocks.diagnosticsReference, status: "available", supported: true, retry: vi.fn() });
  spacePageTestMocks.Chalk.mockClear();
  spacePageTestMocks.open.mockReset();
  spacePageTestMocks.telemetry.configureApiBaseURL.mockReset();
}

export async function cleanupSpacePageTestMocks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
}

function makeRelease(cleanup: () => Promise<void>): ReturnType<typeof vi.fn> {
  let releasePromise: Promise<void> | undefined;
  return vi.fn(() => {
    if (releasePromise) return releasePromise;
    releasePromise = cleanup().catch((cause: unknown) => {
      releasePromise = undefined;
      throw cause;
    });
    return releasePromise;
  });
}
