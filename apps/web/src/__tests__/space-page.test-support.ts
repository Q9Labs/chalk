import { createElement, useState, type ChangeEvent, type ReactNode } from "react";
import { vi } from "vitest";

import type { DashboardPublicAdmissionRequestPage } from "../lib/dashboard-api";

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
  return createElement(
    "main",
    null,
    createElement("label", { htmlFor: "mock-entrance-name" }, "Your name"),
    createElement("input", { id: "mock-entrance-name", "aria-label": "Your name", value: displayName, onChange: (event: ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value) }),
    error ? createElement("p", { role: "alert" }, error) : null,
    createElement("button", { type: "button", onClick: () => void onJoin({ displayName: displayName.trim(), microphone: true, camera: true }), disabled: joining || !displayName.trim() }, joining ? "Joining…" : "Continue"),
  );
}

const spacePageTestMocks = vi.hoisted(() => {
  const holder: { chalkProps?: Record<string, unknown> } = {};
  const journey = { headers: {}, recordDiagnostic: vi.fn(), recordHttpRequest: vi.fn(), recordRtcSummary: vi.fn() };
  const telemetry = { configureApiBaseURL: vi.fn() };
  const clientSnapshot = { connection: { episode: { id: "33333333-3333-4333-8333-333333333333" } } };
  const client = { getSnapshot: vi.fn(() => clientSnapshot), subscribe: vi.fn(() => () => undefined), media: {}, leave: vi.fn(async () => undefined), dispose: vi.fn() };
  const finish = vi.fn(async (_options?: { readonly keepalive?: boolean }) => undefined);
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
    getAccess: vi.fn(),
    connectionAccess: vi.fn(),
    finish,
  };
  const useEpisodeDiagnosticsAvailability = vi.fn(() => ({
    path: "/developer/episode-diagnostics/chalk.episode:33333333-3333-4333-8333-333333333333",
    reference: "chalk.episode:33333333-3333-4333-8333-333333333333",
    status: "available",
    supported: true,
    retry: vi.fn(),
  }));
  return {
    holder,
    journey,
    telemetry,
    client,
    publicClient,
    prepared,
    finish,
    useEpisodeDiagnosticsAvailability,
    createPublicInviteClient: vi.fn(() => publicClient),
    createPreparedPublicSpace: vi.fn(() => prepared),
    createLocalSpaceClient: vi.fn(() => client),
    createLocalSpaceRelease: vi.fn((_client: unknown, cleanup: () => Promise<void>) => makeRelease(cleanup)),
    Chalk: vi.fn((props: Record<string, unknown>) => {
      holder.chalkProps = props;
      return null;
    }),
    listAllAccountTenants: vi.fn(async () => [{ tenant: { id: "tenant-1" } }]),
    listSpaces: vi.fn(async () => ({ spaces: [], pagination: { page_size: 100, next_cursor: null, has_more: false } })),
    listSpacePublicAdmissionRequests: vi.fn(async (): Promise<DashboardPublicAdmissionRequestPage> => ({ requests: [] })),
    approveSpacePublicAdmissionRequest: vi.fn(async () => undefined),
    denySpacePublicAdmissionRequest: vi.fn(async () => undefined),
    joinDashboardSpace: vi.fn(),
  };
});

vi.mock("@q9labsai/chalk-react", () => ({ Chalk: getSpacePageTestMocks().Chalk, Entrance: MockEntrance }));
vi.mock("../lib/chalk-access", () => ({
  createPublicInviteClient: getSpacePageTestMocks().createPublicInviteClient,
  createPreparedPublicSpace: getSpacePageTestMocks().createPreparedPublicSpace,
  joinDashboardSpace: getSpacePageTestMocks().joinDashboardSpace,
}));
vi.mock("../lib/dashboard-api", () => ({
  listAllAccountTenants: getSpacePageTestMocks().listAllAccountTenants,
  listSpaces: getSpacePageTestMocks().listSpaces,
  listSpacePublicAdmissionRequests: getSpacePageTestMocks().listSpacePublicAdmissionRequests,
  approveSpacePublicAdmissionRequest: getSpacePageTestMocks().approveSpacePublicAdmissionRequest,
  denySpacePublicAdmissionRequest: getSpacePageTestMocks().denySpacePublicAdmissionRequest,
}));
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

export function resetSpacePageTestMocks(): void {
  window.history.replaceState({}, "", "/space");
  spacePageTestMocks.holder.chalkProps = undefined;
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
  spacePageTestMocks.useEpisodeDiagnosticsAvailability.mockReset().mockReturnValue({
    path: "/developer/episode-diagnostics/chalk.episode:33333333-3333-4333-8333-333333333333",
    reference: "chalk.episode:33333333-3333-4333-8333-333333333333",
    status: "available",
    supported: true,
    retry: vi.fn(),
  });
  spacePageTestMocks.Chalk.mockClear();
  spacePageTestMocks.joinDashboardSpace.mockReset();
  spacePageTestMocks.listSpacePublicAdmissionRequests.mockReset().mockResolvedValue({ requests: [] });
  spacePageTestMocks.approveSpacePublicAdmissionRequest.mockReset().mockResolvedValue(undefined);
  spacePageTestMocks.denySpacePublicAdmissionRequest.mockReset().mockResolvedValue(undefined);
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
