/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { opaqueAccessGrant } from "../../../../../sdks/typescript/client/src/space-client/core.test.helpers";
import { createSpaceClientForPlatform } from "../../../../../sdks/typescript/client/src/space-client/space-client";
import { terminalTestPlatform } from "../../../../../sdks/typescript/client/src/space-client/terminal.test.helpers";
import { OwnerCall } from "./OwnerCall";
import { DashboardRequestError } from "../../lib/dashboard/client";
import { requireParsedAccessGrant } from "../../../../../sdks/typescript/client/src/access/grant";

const mocks = vi.hoisted(() => ({ createClient: vi.fn(), dashboardAction: vi.fn() }));
vi.mock("@q9labsai/chalk-client/effect", () => ({ createSpaceClientForPlatform: mocks.createClient }));
vi.mock("@q9labsai/chalk-react", async () => ({ Chalk: (await import("../../../../../sdks/typescript/react/src/components/chalk/Chalk")).Chalk }));
vi.mock("../../../../../sdks/typescript/react/src/components/space-view/SpaceView", async () => {
  const { SpaceHeader } = await import("../../../../../sdks/typescript/react/src/components/space-header/SpaceHeader");
  return { SpaceView: (props: Omit<React.ComponentProps<typeof SpaceHeader>, "spaceName">) => <SpaceHeader {...props} spaceName="Camera test" /> };
});
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./AppShell", () => ({
  useSession: () => ({ profile: { name: "Owner" } }),
  useLoad: () => ({ state: { kind: "ready", data: { inviteUrl: "https://chalk.test/invite", call: { name: "Camera test" } } } }),
}));
vi.mock("../site/theme", () => ({ useSiteTheme: () => ({ theme: "dark", setTheme: vi.fn() }), SiteRoot: ({ children }: React.PropsWithChildren) => children }));
vi.mock("../../lib/dashboard/client", async (original) => ({ ...(await original<typeof import("../../lib/dashboard/client")>()), act: mocks.dashboardAction }));
vi.mock("../../lib/chalk-access", () => ({ publicAPIBaseURL: () => "https://api.chalk.test" }));
vi.mock("../../lib/problem-reports", async (original) => ({ ...(await original<typeof import("../../lib/problem-reports")>()), useProblemReports: () => true }));

it("keeps an open owner report editable with Send disabled when the five-minute proof expires", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  window.sessionStorage.clear();
  const platform = terminalTestPlatform();
  const requests = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", requests);
  mocks.dashboardAction.mockResolvedValue({ access: opaqueAccessGrant(1) });
  mocks.createClient.mockImplementation((options) =>
    createSpaceClientForPlatform(options, {
      ...platform,
      fetch: async () => new Response(null, { status: 204 }),
      dependencies: {
        ...platform.dependencies,
        createSyncClient: () => ({
          ...platform.sync,
          stop: platform.syncStopped,
          start: async () => platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase: "terminal", terminalReason: "episode_ended" } }),
        }),
      },
    }),
  );
  try {
    await act(async () => render(<OwnerCall spaceId="space-1" />));
    await act(async () => vi.waitFor(() => expect(screen.getByText("The call ended")).toBeDefined()));
    fireEvent.click(screen.getByRole("button", { name: "Report a problem" }));
    const input = screen.getByLabelText<HTMLTextAreaElement>("What went wrong?");
    fireEvent.change(input, { target: { value: "My camera froze after joining." } });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(screen.getByLabelText("What went wrong?")).toBe(input);
    expect(input.value).toBe("My camera froze after joining.");
    expect(input.disabled).toBe(false);
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("Your call access has expired");
    expect(screen.queryByRole("button", { name: "Report a problem" })).toBeNull();
    fireEvent.change(input, { target: { value: "I can still edit and copy this." } });
    expect(input.value).toBe("I can still edit and copy this.");
    const form = input.form;
    if (!form) throw new Error("Report form missing");
    await act(async () => fireEvent.submit(form));
    expect(requests.mock.calls.map(([url]) => url)).toEqual(["https://api.chalk.test/v1/tenants/tenant-1/connection-reports"]);
  } finally {
    await act(async () => cleanup());
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  }
});

it("re-enables an expired owner draft after a quiet access-only refresh", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  window.sessionStorage.clear();
  const platform = terminalTestPlatform();
  let refresh: import("@q9labsai/chalk-client").GetAccess | undefined;
  let recovered = false;
  mocks.dashboardAction.mockImplementation(async (_page, input) => {
    if (input.action === "refresh-access" && !recovered) throw new Error("API temporarily unavailable");
    return { access: opaqueAccessGrant(1) };
  });
  mocks.createClient.mockImplementation((options) => {
    refresh = options.getAccess;
    return createSpaceClientForPlatform(options, { ...platform, fetch: async () => new Response(null, { status: 204 }) });
  });
  try {
    await act(async () => render(<OwnerCall spaceId="space-1" />));
    await act(async () => vi.waitFor(() => expect(screen.getByRole("button", { name: "Call details" })).toBeDefined()));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Call details" })));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Report a problem" })));
    const input = screen.getByLabelText<HTMLTextAreaElement>("What went wrong?");
    fireEvent.change(input, { target: { value: "Keep my draft during renewal" } });
    await act(async () => vi.advanceTimersByTimeAsync(300_001));
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
    recovered = true;
    const refreshAccess = refresh;
    if (!refreshAccess) throw new Error("Owner access callback missing");
    await act(async () => {
      await refreshAccess({ space: "space-1", reason: "refresh", replaceMediaConnection: false, signal: new AbortController().signal });
    });
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(false);
    expect(screen.getByLabelText("What went wrong?")).toBe(input);
    expect(input.value).toBe("Keep my draft during renewal");
    expect(screen.queryByRole("alert")).toBeNull();
    const join = mocks.dashboardAction.mock.calls.find(([, input]) => input.action === "join")?.[1];
    expect(join).toBeDefined();
    const renewals = mocks.dashboardAction.mock.calls.filter(([, input]) => input.action === "refresh-access");
    expect(renewals.length).toBeGreaterThan(0);
    for (const [, input] of renewals) expect(input.joinKey).toBe(join?.idempotencyKey);
  } finally {
    await act(async () => cleanup());
    vi.useRealTimers();
    vi.clearAllMocks();
  }
});

it.each([
  { label: "denial", error: new DashboardRequestError(401, "join_required"), terminal: true },
  { label: "forbidden", error: new DashboardRequestError(403, "csrf_rejected"), terminal: true },
  { label: "conflict", error: new DashboardRequestError(409, "engine_conflict"), terminal: true },
  { label: "5xx", error: new DashboardRequestError(502, "engine_unavailable"), terminal: false },
  { label: "network", error: new TypeError("Failed to fetch"), terminal: false },
  { label: "rate limit", error: new DashboardRequestError(429, "engine_rate_limited"), terminal: false },
])("passes dashboard $label refresh failures through the SDK access contract", async ({ error, terminal }) => {
  window.sessionStorage.clear();
  const platform = terminalTestPlatform();
  let refresh: import("@q9labsai/chalk-client").GetAccess | undefined;
  mocks.dashboardAction.mockImplementation(async (_page, input) => {
    if (input.action === "refresh-access") throw error;
    return { access: opaqueAccessGrant(1) };
  });
  mocks.createClient.mockImplementation((options) => {
    refresh = options.getAccess;
    return createSpaceClientForPlatform(options, { ...platform, fetch: async () => new Response(null, { status: 204 }) });
  });
  try {
    await act(async () => render(<OwnerCall spaceId="space-1" />));
    await act(async () => vi.waitFor(() => expect(screen.getByRole("button", { name: "Call details" })).toBeDefined()));
    if (!refresh) throw new Error("Owner access callback missing");
    const result = refresh({ space: "space-1", reason: "refresh", replaceMediaConnection: false, signal: new AbortController().signal });
    if (terminal) {
      const response = await result;
      expect(response).toBeInstanceOf(Response);
      await expect(requireParsedAccessGrant(response)).rejects.toMatchObject({ code: "access.invalid" });
    } else await expect(result).rejects.toBe(error);
  } finally {
    await act(async () => cleanup());
    vi.clearAllMocks();
  }
});
