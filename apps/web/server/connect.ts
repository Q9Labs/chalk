import { Schema } from "effect";
import { UUIDSchema } from "@q9labsai/chalk-client/effect";
import type { ActionResult, ConnectAction, ConnectDTO, ConnectionsAction, ConnectionsDTO } from "../src/lib/dashboard/contracts";
import type { Engine } from "./engine";
import { run } from "./engine";

// Connected apps are Claude, ChatGPT and other MCP clients that signed in through OAuth.
// The tenant always comes from the signed-in session (engine.tenantId), never from the request.

function bundle(scope: string): "chalk:read" | "chalk:manage" {
  return scope === "chalk:manage" ? "chalk:manage" : "chalk:read";
}

export async function connectPage(engine: Engine, request: string): Promise<ConnectDTO> {
  // The tenant name only labels the account on the page, so the page still loads without it.
  const [found, tenant] = await Promise.all([run(engine.api.default.inspectMCPConsentRequest({ payload: { request } })), run(engine.api.tenants.getTenant({ params: { tenant_id: engine.tenantId } })).catch(() => null)]);
  return { clientName: found.client_name, redirectHost: found.redirect_host, requestedScope: bundle(found.scope), tenantName: tenant?.name ?? null };
}

/** Returns the URL that sends the browser back to the app, with a code or an error. */
export async function connectMutation(engine: Engine, action: ConnectAction): Promise<ActionResult<ConnectAction>> {
  const result = action.action === "approve-connection" ? await run(engine.api.default.approveMCPConsentRequest({ payload: { request: action.request, scope: action.scope, tenant_id: engine.tenantId } })) : await run(engine.api.default.denyMCPConsentRequest({ payload: { request: action.request } }));
  return { redirectUrl: result.redirect_url };
}

function connectionRow(row: { id: string; client_name: string; scope: string; last_used_at: string | null; created_at: string }) {
  return { id: row.id, clientName: row.client_name, scope: bundle(row.scope), lastUsedAt: row.last_used_at, createdAt: row.created_at };
}

const NAME_PAGE_SIZE = 100;
const NAME_PAGE_LIMIT = 20;

/**
 * One page of grants for the table. The first page also names every connected app, so the catalog badges stay right when the table holds more than one page.
 * The Chalk URL does not depend on the grants, so a failed read still returns it with `listError` set and the catalog stays usable.
 */
export async function connectionsPage(engine: Engine, cursor?: string): Promise<ConnectionsDTO> {
  const read = (pageCursor: string | undefined, pageSize: number) => run(engine.api.default.listMCPConnections({ params: { tenant_id: engine.tenantId }, query: { page_size: pageSize, cursor: pageCursor } }));
  if (cursor) {
    const result = await read(cursor, 25);
    return { mcpUrl: engine.mcpUrl, connections: result.data.map(connectionRow), nextCursor: result.pagination.next_cursor, connectedNames: [], listError: false };
  }
  let first: Awaited<ReturnType<typeof read>>;
  try {
    first = await read(undefined, 25);
  } catch (error) {
    logFailure(engine, error);
    return { mcpUrl: engine.mcpUrl, connections: [], nextCursor: null, connectedNames: [], listError: true };
  }
  const names = new Set(first.data.map((row) => row.client_name));
  // The names only drive the catalog badges, so a failed scan keeps the table and leaves the badges to the pages already read.
  try {
    let next = first.pagination.next_cursor;
    for (let pages = 0; next && pages < NAME_PAGE_LIMIT; pages++) {
      const more = await read(next, NAME_PAGE_SIZE);
      for (const row of more.data) names.add(row.client_name);
      next = more.pagination.next_cursor;
    }
  } catch (error) {
    logFailure(engine, error);
  }
  return { mcpUrl: engine.mcpUrl, connections: first.data.map(connectionRow), nextCursor: first.pagination.next_cursor, connectedNames: [...names], listError: false };
}

function logFailure(engine: Engine, error: unknown) {
  console.warn(JSON.stringify({ event: "dashboard.mcp_connections_failed", tenant_id: engine.tenantId, error: error instanceof Error ? error.name : "unknown" }));
}

export async function connectionsMutation(engine: Engine, action: ConnectionsAction): Promise<ActionResult<ConnectionsAction>> {
  await run(engine.api.default.revokeMCPConnection({ params: { tenant_id: engine.tenantId, connection_id: Schema.decodeUnknownSync(UUIDSchema)(action.connectionId) } }));
  return { ok: true };
}
