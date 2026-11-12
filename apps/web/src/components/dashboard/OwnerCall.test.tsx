/* @vitest-environment jsdom */

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SpaceClient } from "@q9labsai/chalk-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

type Snapshot = ReturnType<SpaceClient["getSnapshot"]>;
const fake = vi.hoisted(() => ({ client: undefined as unknown }));

vi.mock("./AppShell", () => ({
  useSession: () => ({ profile: { id: "user-1", name: "Ada" }, failure: null, retry: () => undefined }),
  useLoad: () => ({ state: { kind: "ready", data: { inviteUrl: "https://chalkmeet.com/abc-defg-hij", call: { name: "Standup" } } }, reload: () => undefined }),
}));
vi.mock("../site/theme", () => ({ SiteRoot: ({ children }: { children: unknown }) => children, useSiteTheme: () => ({ theme: "light", setTheme: () => undefined }) }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("@q9labsai/chalk-react", () => ({ Chalk: () => null }));
vi.mock("../../lib/local-space-client", () => ({ createLocalSpaceClient: () => fake.client }));
vi.mock("../../lib/problem-reports", () => ({
  problemReporter: () => () => undefined,
  reportCredentialExpiredReason: "expired",
  useProblemReports: () => false,
  useReportCredentialExpired: () => false,
}));

import { OwnerCall } from "./OwnerCall";

const joinKeyStorage = "chalk.owner-join:user-1:space-1";

/** A client whose snapshot a test sets, and whose `close()` resolves whatever the leave did. */
function fakeClient(): { client: SpaceClient; set: (connection: Partial<Snapshot["connection"]>) => void } {
  let snapshot = { connection: { status: "idle", lastError: null, episodeEnded: false, removedByHost: false } } as unknown as Snapshot;
  const listeners = new Set<() => void>();
  const client = {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    close: async () => undefined,
  } as unknown as SpaceClient;
  const set = (connection: Partial<Snapshot["connection"]>) => {
    snapshot = { ...snapshot, connection: { ...snapshot.connection, ...connection } };
    for (const listener of listeners) listener();
  };
  return { client, set };
}

let view: ReturnType<typeof createRoot> | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function leaveAndUnmount(connection: Partial<Snapshot["connection"]>): Promise<void> {
  const { client, set } = fakeClient();
  fake.client = client;
  view = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => view?.render(<OwnerCall spaceId="space-1" />));
  expect(sessionStorage.getItem(joinKeyStorage)).not.toBeNull();
  await act(async () => set({ status: "live" }));
  await act(async () => set(connection));
  await act(async () => view?.unmount());
}

it("forgets the owner's seat after a confirmed leave", async () => {
  await leaveAndUnmount({ status: "left", lastError: null });
  expect(sessionStorage.getItem(joinKeyStorage)).toBeNull();
});

it("keeps the owner's join key when the leave was never confirmed, so a return reuses the seat", async () => {
  await leaveAndUnmount({ status: "left", lastError: { code: "connection.leave_unconfirmed" } as Snapshot["connection"]["lastError"] });
  expect(sessionStorage.getItem(joinKeyStorage)).not.toBeNull();
});
