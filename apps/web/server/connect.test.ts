import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import { connectAction, connectionsAction } from "../src/lib/dashboard/contracts";
import { connectMutation, connectPage, connectionsMutation, connectionsPage } from "./connect";
import type { Engine } from "./engine";

const handle = `chalk_oar_${"a".repeat(43)}`;
const tenantId = "11111111-1111-4111-8111-111111111111";

function engine(api: Record<string, unknown>) {
  return { api: { default: api, tenants: { getTenant: () => Effect.succeed({ name: "Hasan Shoaib" }) } }, tenantId, dashboardOrigin: "https://dashboard.example.test", mcpUrl: "https://api.example.test/mcp" } as unknown as Engine;
}

it("approves for the signed-in session's tenant and never a tenant from the request", async () => {
  const approve = vi.fn(() => Effect.succeed({ redirect_url: "https://claude.ai/api/mcp/auth_callback?code=c&state=s" }));
  const parsed = connectAction.parse({ action: "approve-connection", request: handle, scope: "chalk:read" });
  const result = await connectMutation(engine({ approveMCPConsentRequest: approve }), parsed);
  expect(result.redirectUrl).toContain("claude.ai");
  expect(approve).toHaveBeenCalledWith({ payload: { request: handle, scope: "chalk:read", tenant_id: tenantId } });
  expect(connectAction.safeParse({ action: "approve-connection", request: handle, scope: "chalk:read", tenantId: crypto.randomUUID() }).success).toBe(false);
});

it("refuses malformed handles and scopes beyond the two bundles", () => {
  expect(connectAction.safeParse({ action: "deny-connection", request: "chalk_sk_secret" }).success).toBe(false);
  expect(connectAction.safeParse({ action: "approve-connection", request: handle, scope: "api_keys:write" }).success).toBe(false);
  expect(connectionsAction.safeParse({ action: "revoke-connection", connectionId: "not-an-id" }).success).toBe(false);
});

it("shows what the app asked for and lists and revokes connections for the session's tenant", async () => {
  const inspect = vi.fn(() => Effect.succeed({ client_name: "Claude", redirect_host: "claude.ai", scope: "chalk:manage", expires_at: "2026-11-05T12:00:00Z" }));
  expect(await connectPage(engine({ inspectMCPConsentRequest: inspect }), handle)).toEqual({ clientName: "Claude", redirectHost: "claude.ai", requestedScope: "chalk:manage", tenantName: "Hasan Shoaib" });

  const noTenant = { api: { default: { inspectMCPConsentRequest: inspect }, tenants: { getTenant: () => Effect.fail(new Error("unavailable")) } }, tenantId, dashboardOrigin: "https://dashboard.example.test" } as unknown as Engine;
  expect(await connectPage(noTenant, handle)).toEqual({ clientName: "Claude", redirectHost: "claude.ai", requestedScope: "chalk:manage", tenantName: null });

  const list = vi.fn(() => Effect.succeed({ data: [{ id: crypto.randomUUID(), client_name: "ChatGPT", scope: "chalk:read", last_used_at: null, created_at: "2026-11-05T10:00:00Z" }], pagination: { page_size: 25, next_cursor: "next", has_more: true } }));
  const page = await connectionsPage(engine({ listMCPConnections: list }), "cursor-1");
  expect(page.connections[0]).toMatchObject({ clientName: "ChatGPT", lastUsedAt: null });
  expect(page.nextCursor).toBe("next");
  expect(page.mcpUrl).toBe("https://api.example.test/mcp");
  expect(list).toHaveBeenCalledWith({ params: { tenant_id: tenantId }, query: { page_size: 25, cursor: "cursor-1" } });

  const revoke = vi.fn(() => Effect.succeed(undefined));
  const connectionId = crypto.randomUUID();
  await connectionsMutation(engine({ revokeMCPConnection: revoke }), { action: "revoke-connection", connectionId });
  expect(revoke).toHaveBeenCalledWith({ params: { tenant_id: tenantId, connection_id: connectionId } });
});

it("names every connected app on the first page, and keeps the Chalk URL when the grants can't be read", async () => {
  const row = (name: string) => ({ id: crypto.randomUUID(), client_name: name, scope: "chalk:read", last_used_at: null, created_at: "2026-11-05T10:00:00Z" });
  const list = vi
    .fn()
    .mockReturnValueOnce(Effect.succeed({ data: [row("Claude")], pagination: { page_size: 25, next_cursor: "c1", has_more: true } }))
    .mockReturnValueOnce(Effect.succeed({ data: [row("Codex"), row("Claude")], pagination: { page_size: 100, next_cursor: null, has_more: false } }));
  const first = await connectionsPage(engine({ listMCPConnections: list }));
  expect(first.connections.map((item) => item.clientName)).toEqual(["Claude"]);
  expect(first.nextCursor).toBe("c1");
  expect(first.connectedNames).toEqual(["Claude", "Codex"]);
  expect(list).toHaveBeenLastCalledWith({ params: { tenant_id: tenantId }, query: { page_size: 100, cursor: "c1" } });

  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const down = await connectionsPage(engine({ listMCPConnections: () => Effect.fail(new Error("rate limited")) }));
  expect(down).toEqual({ mcpUrl: "https://api.example.test/mcp", connections: [], nextCursor: null, connectedNames: [], listError: true });
  warn.mockRestore();

  await expect(connectionsPage(engine({ listMCPConnections: () => Effect.fail(new Error("rate limited")) }), "c1")).rejects.toThrow();
});
