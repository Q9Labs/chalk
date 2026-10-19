import { createElement } from "react";
import type { CallLimboProps, ChalkButtonProps, StatusSurfaceProps } from "@q9labsai/chalk-react";
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
  const prepared = {
    reloadMarker: () => ({ episodeId: "33333333-3333-4333-8333-333333333333", participantId: "participant-1", participantGeneration: 1, mediaProof: "proof", arrivalHandle: "arrival-11111111" }),
    arrival: undefined,
    credential: { apiBaseURL: "https://api.chalk.test", syncURL: "wss://sync.chalk.test/v1/sync", space: "design-lab" },
    getAccess: vi.fn(),
    connectionAccess: vi.fn(),
    finish,
  };
  return {
    holder,
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
    listAllAccountTenants: vi.fn(async () => [{ tenant: { id: "tenant-1" } }]),
    listSpaces: vi.fn(async () => ({ spaces: [], pagination: { page_size: 100, next_cursor: null, has_more: false } })),
    prepareDashboardEntrance: vi.fn(async () => undefined),
    joinDashboardSpace: vi.fn(),
    resumePublicSpace: vi.fn(),
  };
});
vi.mock("@q9labsai/chalk-react", () => ({
  Chalk: getSpacePageTestMocks().Chalk,
  StatusSurface: ({ phase, callName, onRejoin, onHome, rejoinDisabled }: StatusSurfaceProps) =>
    createElement(
      "section",
      null,
      createElement("h1", null, phase === "left" ? `You left ${callName}` : phase),
      onRejoin ? createElement("button", { type: "button", onClick: onRejoin, disabled: rejoinDisabled }, "Rejoin") : null,
      onHome ? createElement("button", { type: "button", onClick: onHome }, "Home") : null,
    ),
  CallLimbo: ({ message, detail, children, action }: CallLimboProps) =>
    createElement("section", null, createElement("p", { role: "status" }, message), detail ? createElement("p", null, detail) : null, children, action ? createElement("button", { type: "button", onClick: action.onClick, disabled: action.disabled }, action.label) : null),
  ChalkButton: ({ children, type, disabled, onClick }: ChalkButtonProps) => createElement("button", { type, disabled, onClick }, children),
}));
vi.mock("../lib/chalk-access", () => ({
  createPublicInviteClient: getSpacePageTestMocks().createPublicInviteClient,
  createPreparedPublicSpace: getSpacePageTestMocks().createPreparedPublicSpace,
  prepareDashboardEntrance: getSpacePageTestMocks().prepareDashboardEntrance,
  joinDashboardSpace: getSpacePageTestMocks().joinDashboardSpace,
  resumePublicSpace: getSpacePageTestMocks().resumePublicSpace,
}));
vi.mock("../lib/account-api", () => ({ getAccount: getSpacePageTestMocks().getAccount, listAllAccountTenants: getSpacePageTestMocks().listAllAccountTenants, listSpaces: getSpacePageTestMocks().listSpaces }));
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
  spacePageTestMocks.publicClient.prepareSpaceEntrance.mockClear();
  spacePageTestMocks.prepareDashboardEntrance.mockClear();
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
