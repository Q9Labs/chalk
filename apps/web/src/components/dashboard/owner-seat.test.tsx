/* @vitest-environment jsdom */

import type { SpaceClient } from "@q9labsai/chalk-client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ownerAccess } from "./owner-seat";

type Connection = ReturnType<SpaceClient["getSnapshot"]>["connection"];

const joinKeyStorage = "chalk.owner-join:user-1:space-1";
const subject = { tenant_id: "t", space_id: "space-1", episode_id: "e", participant_id: "p", participant_generation: 1 };

/** The dashboard server, as the owner's browser sees it: a session, then an admission. */
beforeEach(() => {
  sessionStorage.clear();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/auth/session") return Response.json({ profile: { id: "user-1", name: "Ada" }, csrfToken: "csrf" });
    if (path === "/dashboard-api/call") return Response.json({ access: { subject, sync: { token: "s", expires_at: "2099-01-01T00:00:00Z" }, media: { token: "m", expires_at: "2099-01-01T00:00:00Z", provider: "cloudflare_sfu", client_payload: {} } } });
    return Response.json({ error: { code: "unexpected" } }, { status: 500 });
  });
});
afterEach(() => vi.unstubAllGlobals());

/** An owner who has joined, and left in the given way. */
async function ownerWhoLeft(connection: Pick<Connection, "status" | "lastError">): Promise<void> {
  const owner = ownerAccess("space-1", "user-1");
  await owner.getAccess({ space: "space-1", reason: "join", replaceMediaConnection: false });
  owner.observe({ connection: { status: "live" } } as ReturnType<SpaceClient["getSnapshot"]>);
  expect(sessionStorage.getItem(joinKeyStorage)).not.toBeNull();
  owner.afterClose({ ...connection } as Connection);
}

it("forgets the owner's seat after a confirmed leave", async () => {
  await ownerWhoLeft({ status: "left", lastError: null });
  expect(sessionStorage.getItem(joinKeyStorage)).toBeNull();
});

it("keeps the owner's join key when the leave was never confirmed, so a return reuses the seat", async () => {
  await ownerWhoLeft({ status: "left", lastError: { code: "connection.leave_unconfirmed" } as Connection["lastError"] });
  expect(sessionStorage.getItem(joinKeyStorage)).not.toBeNull();
});
