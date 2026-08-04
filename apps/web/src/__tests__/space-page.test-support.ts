import { vi } from "vitest";

const spacePageTestMocks = vi.hoisted(() => {
  const holder: { chalkProps?: Record<string, unknown> } = {};
  const journey = { headers: {}, recordDiagnostic: vi.fn(), recordHttpRequest: vi.fn() };
  const telemetry = { configureApiBaseURL: vi.fn() };
  const client = {};
  const getAccess = vi.fn();
  return {
    holder,
    journey,
    telemetry,
    client,
    getAccess,
    Chalk: vi.fn((props: Record<string, unknown>) => {
      holder.chalkProps = props;
      return null;
    }),
    cleanupParticipantCredential: vi.fn(async (): Promise<void> => undefined),
    createAccessGrantProvider: vi.fn(() => getAccess),
    createParticipantCredential: vi.fn(),
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
}));
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

function isTerminalParticipantCredentialCleanupError(cause: unknown): boolean {
  return cause instanceof Error && "status" in cause && [401, 404, 410].includes(Number((cause as { readonly status?: unknown }).status));
}

export function resetSpacePageTestMocks(): void {
  window.history.replaceState({}, "", "/space");
  spacePageTestMocks.holder.chalkProps = undefined;
  spacePageTestMocks.createParticipantCredential.mockReset().mockResolvedValue(spacePageTestCredential);
  spacePageTestMocks.cleanupParticipantCredential.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.createAccessGrantProvider.mockReset().mockReturnValue(spacePageTestMocks.getAccess);
  spacePageTestMocks.createLocalSpaceClient.mockReset().mockReturnValue(spacePageTestMocks.client);
  spacePageTestMocks.createLocalSpaceRelease.mockReset().mockImplementation((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup));
  spacePageTestMocks.Chalk.mockClear();
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
