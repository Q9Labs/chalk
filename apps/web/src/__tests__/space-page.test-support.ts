import { vi } from "vitest";

const spacePageTestMocks = vi.hoisted(() => {
  const holder: { chalkProps?: Record<string, unknown> } = {};
  const journey = { headers: {}, recordDiagnostic: vi.fn(), recordHttpRequest: vi.fn() };
  const telemetry = { configureApiBaseURL: vi.fn() };
  const episodeID = "33333333-3333-4333-8333-333333333333";
  const diagnosticsPath = `/developer/episode-diagnostics/${encodeURIComponent(`chalk.episode:${episodeID}`)}`;
  const clientSnapshot = { connection: { episode: { id: episodeID } } };
  const client = { getSnapshot: vi.fn(() => clientSnapshot), subscribe: vi.fn(() => () => undefined) };
  const getAccess = vi.fn();
  const dashboardGetAccess = vi.fn();
  const connectionAccess = { access: "dashboard" };
  return {
    holder,
    journey,
    telemetry,
    client,
    connectionAccess,
    dashboardGetAccess,
    diagnosticsPath,
    episodeID,
    getAccess,
    localStorage: { getItem: vi.fn(), setItem: vi.fn() },
    open: vi.fn(),
    useEpisodeDiagnosticsAvailability: vi.fn(() => ({ path: diagnosticsPath, status: "available", supported: true, retry: vi.fn() }) as { readonly path?: string; readonly status: "available" | "checking" | "unavailable"; readonly supported: boolean; readonly retry: () => void }),
    Chalk: vi.fn((props: Record<string, unknown>) => {
      holder.chalkProps = props;
      return null;
    }),
    cleanupParticipantCredential: vi.fn(async (): Promise<void> => undefined),
    createAccessGrantProvider: vi.fn(() => getAccess),
    createParticipantCredential: vi.fn(),
    joinDashboardSpace: vi.fn(),
    listAllAccountTenants: vi.fn(),
    createLocalSpaceClient: vi.fn(() => client),
    createLocalSpaceRelease: vi.fn((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup)),
  };
});

vi.mock("@q9labsai/chalk-react", () => ({ Chalk: getSpacePageTestMocks().Chalk }));
vi.mock("../lib/chalk-access", () => ({
  cleanupParticipantCredential: getSpacePageTestMocks().cleanupParticipantCredential,
  createAccessGrantProvider: getSpacePageTestMocks().createAccessGrantProvider,
  createParticipantCredential: getSpacePageTestMocks().createParticipantCredential,
  isTerminalParticipantCredentialCleanupError,
  joinDashboardSpace: getSpacePageTestMocks().joinDashboardSpace,
}));
vi.mock("../lib/dashboard-api", () => ({ listAllAccountTenants: getSpacePageTestMocks().listAllAccountTenants }));
vi.mock("../lib/local-space-client", () => ({ createLocalSpaceClient: getSpacePageTestMocks().createLocalSpaceClient, createLocalSpaceRelease: getSpacePageTestMocks().createLocalSpaceRelease }));
vi.mock("../lib/web-telemetry-context", () => ({ useWebTelemetry: () => ({ journey: getSpacePageTestMocks().journey, telemetry: getSpacePageTestMocks().telemetry }) }));
vi.mock("../features/episode-debugger/EpisodeDiagnosticsDeveloperLink", () => ({ useEpisodeDiagnosticsAvailability: getSpacePageTestMocks().useEpisodeDiagnosticsAvailability }));

export function getSpacePageTestMocks(): typeof spacePageTestMocks {
  return spacePageTestMocks;
}

export const spacePageTestCredential = {
  apiBaseURL: "https://api.chalk.test/control",
  syncURL: "wss://sync.chalk.test/v1/sync",
  spaceInviteToken: "i".repeat(43),
};

function isTerminalParticipantCredentialCleanupError(cause: unknown): boolean {
  return cause instanceof Error && "status" in cause && [401, 404, 410].includes(Number((cause as { readonly status?: unknown }).status));
}

export function resetSpacePageTestMocks(): void {
  window.history.replaceState({}, "", "/space");
  vi.stubGlobal("localStorage", spacePageTestMocks.localStorage);
  vi.stubGlobal("open", spacePageTestMocks.open);
  spacePageTestMocks.holder.chalkProps = undefined;
  spacePageTestMocks.createParticipantCredential.mockReset().mockResolvedValue(spacePageTestCredential);
  spacePageTestMocks.cleanupParticipantCredential.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.createAccessGrantProvider.mockReset().mockReturnValue(spacePageTestMocks.getAccess);
  spacePageTestMocks.createLocalSpaceClient.mockReset().mockReturnValue(spacePageTestMocks.client);
  spacePageTestMocks.createLocalSpaceRelease.mockReset().mockImplementation((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup));
  spacePageTestMocks.joinDashboardSpace.mockReset().mockResolvedValue({ credential: spacePageTestCredential, getAccess: spacePageTestMocks.dashboardGetAccess, connectionAccess: spacePageTestMocks.connectionAccess, leave: vi.fn(async () => undefined) });
  spacePageTestMocks.listAllAccountTenants.mockReset().mockResolvedValue([]);
  spacePageTestMocks.localStorage.getItem.mockReset().mockReturnValue(null);
  spacePageTestMocks.localStorage.setItem.mockReset();
  spacePageTestMocks.useEpisodeDiagnosticsAvailability.mockReset().mockReturnValue({ path: spacePageTestMocks.diagnosticsPath, status: "available", supported: true, retry: vi.fn() });
  spacePageTestMocks.Chalk.mockClear();
  spacePageTestMocks.open.mockReset();
  spacePageTestMocks.telemetry.configureApiBaseURL.mockReset();
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
