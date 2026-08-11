import { vi } from "vitest";

const spacePageTestMocks = vi.hoisted(() => {
  const holder: { chalkProps?: Record<string, unknown> } = {};
  const journey = { headers: {}, recordDiagnostic: vi.fn(), recordHttpRequest: vi.fn() };
  const telemetry = { configureApiBaseURL: vi.fn() };
  const client = {};
  const getAccess = vi.fn();
  const dashboardGetAccess = vi.fn();
  const dashboardConnectionAccess = vi.fn();
  const dashboardLeave = vi.fn(async (): Promise<void> => undefined);
  const listAllAccountTenants = vi.fn();
  const joinDashboardSpace = vi.fn();
  return {
    holder,
    journey,
    telemetry,
    client,
    getAccess,
    dashboardGetAccess,
    dashboardConnectionAccess,
    dashboardLeave,
    listAllAccountTenants,
    joinDashboardSpace,
    Chalk: vi.fn((props: Record<string, unknown>) => {
      holder.chalkProps = props;
      return null;
    }),
    cleanupParticipantCredential: vi.fn(async (): Promise<void> => undefined),
    createAccessGrantProvider: vi.fn(() => getAccess),
    createParticipantCredential: vi.fn(),
    isUnauthenticatedDashboardSpaceError: vi.fn((cause: unknown) => cause instanceof Error && "status" in cause && Number((cause as { readonly status?: unknown }).status) === 401),
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
  isUnauthenticatedDashboardSpaceError: getSpacePageTestMocks().isUnauthenticatedDashboardSpaceError,
  joinDashboardSpace: getSpacePageTestMocks().joinDashboardSpace,
}));
vi.mock("../lib/dashboard-api", () => {
  class DashboardAPIError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { DashboardAPIError, listAllAccountTenants: getSpacePageTestMocks().listAllAccountTenants };
});
vi.mock("../lib/local-space-client", () => ({ createLocalSpaceClient: getSpacePageTestMocks().createLocalSpaceClient, createLocalSpaceRelease: getSpacePageTestMocks().createLocalSpaceRelease }));
vi.mock("../lib/web-telemetry-context", () => ({ useWebTelemetry: () => ({ journey: getSpacePageTestMocks().journey, telemetry: getSpacePageTestMocks().telemetry }) }));

export function getSpacePageTestMocks(): typeof spacePageTestMocks {
  return spacePageTestMocks;
}

export const spacePageTestCredential = {
  apiBaseURL: "https://api.chalk.test/control",
  syncURL: "wss://sync.chalk.test/v1/sync",
  spaceInviteToken: "i".repeat(43),
};

export const dashboardSpaceTestAccess = {
  credential: {
    apiBaseURL: "https://api.chalk.test",
    space: "design-lab",
    access: {},
    participantGeneration: 1,
  },
  getAccess: spacePageTestMocks.dashboardGetAccess,
  connectionAccess: spacePageTestMocks.dashboardConnectionAccess,
  leave: spacePageTestMocks.dashboardLeave,
};

function isTerminalParticipantCredentialCleanupError(cause: unknown): boolean {
  return cause instanceof Error && "status" in cause && [401, 404, 410].includes(Number((cause as { readonly status?: unknown }).status));
}

export function resetSpacePageTestMocks(): void {
  Object.defineProperty(window, "localStorage", { configurable: true, value: testStorage() });
  window.history.replaceState({}, "", "/space");
  spacePageTestMocks.holder.chalkProps = undefined;
  spacePageTestMocks.createParticipantCredential.mockReset().mockResolvedValue(spacePageTestCredential);
  spacePageTestMocks.listAllAccountTenants.mockReset().mockResolvedValue([{ tenant: { id: "tenant-1" } }]);
  spacePageTestMocks.joinDashboardSpace.mockReset().mockResolvedValue(dashboardSpaceTestAccess);
  spacePageTestMocks.dashboardLeave.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.isUnauthenticatedDashboardSpaceError.mockClear();
  spacePageTestMocks.cleanupParticipantCredential.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.createAccessGrantProvider.mockReset().mockReturnValue(spacePageTestMocks.getAccess);
  spacePageTestMocks.createLocalSpaceClient.mockReset().mockReturnValue(spacePageTestMocks.client);
  spacePageTestMocks.createLocalSpaceRelease.mockReset().mockImplementation((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup));
  spacePageTestMocks.Chalk.mockClear();
  spacePageTestMocks.telemetry.configureApiBaseURL.mockReset();
}

function testStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
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
