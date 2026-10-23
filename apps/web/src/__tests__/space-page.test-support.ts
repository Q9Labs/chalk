import { createElement } from "react";
import type { CallLimboProps, ChalkButtonProps } from "@q9labsai/chalk-react";
import { vi } from "vitest";
const spacePageTestMocks = vi.hoisted(() => {
  const holder: {
    chalkProps?: Record<string, unknown>;
    entranceProps?: Record<string, unknown>;
  } = {};
  const clientSnapshot = { self: { displayName: "Ada" }, media: { local: { microphone: { state: "disabled" }, camera: { state: "enabled" } } }, connection: { status: "live", episode: { id: "33333333-3333-4333-8333-333333333333" } } };
  const client = { getSnapshot: vi.fn(() => clientSnapshot), subscribe: vi.fn(() => () => undefined), media: {}, leave: vi.fn(async () => undefined), dispose: vi.fn() };
  const finish = vi.fn(async (_options?: { readonly keepalive?: boolean }) => undefined);
  const publicClient = {
    prepareSpaceEntrance: vi.fn(async () => undefined),
    createPublicSpace: vi.fn(),
    arriveBySpacePublicInvite: vi.fn(),
    getSpacePublicInviteArrival: vi.fn(),
    refreshSpacePublicInviteAccess: vi.fn(),
    leaveSpacePublicInviteArrival: vi.fn(async () => undefined),
  };
  let reportExpiresAt = Date.now() + 300_000;
  const accessListeners = new Set<() => void>();
  const prepared = {
    subscribe: (listener: () => void) => {
      accessListeners.add(listener);
      return () => {
        accessListeners.delete(listener);
      };
    },
    reportCredentialExpiresAt: () => reportExpiresAt,
    reportCredential: () => "proof",
    reloadMarker: () => ({ episodeId: "33333333-3333-4333-8333-333333333333", participantId: "participant-1", participantGeneration: 1, mediaProof: "proof", arrivalHandle: "arrival-11111111", tenantId: "tenant-1" }),
    arrival: { state: "admitted", space: { name: "Design Lab", slug: "design-lab" } },
    credential: { apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", space: "design-lab" },
    getAccess: vi.fn(),
    connectionAccess: vi.fn(),
    finish,
  };
  return {
    holder,
    renewReportAccess: (expiresAt: number) => {
      reportExpiresAt = expiresAt;
      accessListeners.forEach((listener) => listener());
    },
    resetReportAccess: () => {
      accessListeners.clear();
      reportExpiresAt = Date.now() + 300_000;
    },
    reportsAvailable: vi.fn(() => false),
    client,
    publicClient,
    prepared,
    finish,
    createPublicInviteClient: vi.fn(() => publicClient),
    createPreparedPublicSpace: vi.fn(() => prepared),
    createLocalSpaceClient: vi.fn(() => client),
    createLocalSpaceRelease: vi.fn((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup)),
    Chalk: vi.fn((props: Record<string, unknown>) => {
      holder.chalkProps = props;
      return null;
    }),
    getAccount: vi.fn<() => Promise<{ name: string }>>(async () => {
      throw new Error("Not signed in");
    }),
    resumePublicSpace: vi.fn(),
  };
});
vi.mock("../lib/problem-reports", async (importOriginal) => ({ ...(await importOriginal<typeof import("../lib/problem-reports")>()), useProblemReports: () => spacePageTestMocks.reportsAvailable() }));
vi.mock("@q9labsai/chalk-react", async () => ({
  Chalk: getSpacePageTestMocks().Chalk,
  ReportProblemDialog: (await import("../../../../sdks/typescript/react/src/components/chalk/ReportProblemDialog")).ReportProblemDialog,
  StatusSurface: (await import("../../../../sdks/typescript/react/src/components/chalk/StatusSurface")).StatusSurface,
  CallLimbo: ({ message, detail, children, action }: CallLimboProps) =>
    createElement("section", null, createElement("p", { role: "status" }, message), detail ? createElement("p", null, detail) : null, children, action ? createElement("button", { type: "button", onClick: action.onClick, disabled: action.disabled }, action.label) : null),
  ChalkButton: ({ children, type, disabled, onClick }: ChalkButtonProps) => createElement("button", { type, disabled, onClick }, children),
}));
vi.mock("../lib/chalk-access", () => ({
  publicAPIBaseURL: () => "https://api.chalk.test",
  createPublicInviteClient: getSpacePageTestMocks().createPublicInviteClient,
  createPreparedPublicSpace: getSpacePageTestMocks().createPreparedPublicSpace,
  resumePublicSpace: getSpacePageTestMocks().resumePublicSpace,
}));
vi.mock("../lib/account-api", () => ({ getAccount: getSpacePageTestMocks().getAccount }));
vi.mock("../lib/local-space-client", () => ({
  createLocalSpaceClient: getSpacePageTestMocks().createLocalSpaceClient,
  createLocalSpaceRelease: getSpacePageTestMocks().createLocalSpaceRelease,
}));
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
export function resetSpacePageTestMocks(): void {
  spacePageTestMocks.resetReportAccess();
  spacePageTestMocks.reportsAvailable.mockReturnValue(false);
  spacePageTestMocks.publicClient.prepareSpaceEntrance.mockClear();
  window.sessionStorage.clear();
  const names = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => names.get(key) ?? null, setItem: (key: string, value: string) => names.set(key, value) });
  spacePageTestMocks.getAccount.mockReset().mockRejectedValue(new Error("Not signed in"));
  spacePageTestMocks.resumePublicSpace.mockReset().mockResolvedValue(spacePageTestMocks.prepared);
  window.history.replaceState({}, "", "/space");
  spacePageTestMocks.holder.chalkProps = undefined;
  spacePageTestMocks.holder.entranceProps = undefined;
  spacePageTestMocks.publicClient.createPublicSpace.mockReset();
  spacePageTestMocks.publicClient.arriveBySpacePublicInvite.mockReset().mockResolvedValue(spacePageTestArrival);
  spacePageTestMocks.publicClient.getSpacePublicInviteArrival.mockReset().mockResolvedValue(spacePageTestArrival);
  spacePageTestMocks.publicClient.refreshSpacePublicInviteAccess.mockReset().mockResolvedValue(spacePageTestArrival.access);
  spacePageTestMocks.publicClient.leaveSpacePublicInviteArrival.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.createPublicInviteClient.mockClear();
  spacePageTestMocks.createPreparedPublicSpace.mockReset().mockReturnValue(spacePageTestMocks.prepared);
  spacePageTestMocks.prepared.finish.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.createLocalSpaceClient.mockReset().mockReturnValue(spacePageTestMocks.client);
  spacePageTestMocks.createLocalSpaceRelease.mockReset().mockImplementation((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup));
  spacePageTestMocks.Chalk.mockClear();
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

vi.mock("../lib/theme-context", () => ({ useTheme: () => ({ mode: "dark", preference: "dark", setPreference: () => undefined }) }));
