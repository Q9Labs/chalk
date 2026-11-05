import { Schema } from "effect";
import { UUIDSchema } from "@q9labsai/chalk-client/effect";
import type { ConnectAction, ConnectDTO, ConnectionsAction, ConnectionsDTO } from "../src/lib/dashboard/contracts";
import type { Engine } from "./engine";
import { run } from "./engine";

// Connected apps are Claude, ChatGPT and other MCP clients that signed in through OAuth.
// The tenant always comes from the signed-in session (engine.tenantId), never from the request.

function bundle(scope: string): "chalk:read" | "chalk:manage" {
  return scope === "chalk:manage" ? "chalk:manage" : "chalk:read";
}

export async function connectPage(engine: Engine, request: string): Promise<ConnectDTO> {
  const found = await run(engine.api.default.inspectMCPConsentRequest({ payload: { request } }));
  return { clientName: found.client_name, redirectHost: found.redirect_host, requestedScope: bundle(found.scope) };
}

/** Returns the URL that sends the browser back to the app, with a code or an error. */
export async function connectMutation(engine: Engine, action: ConnectAction): Promise<{ redirectUrl: string }> {
  const result = action.action === "approve-connection" ? await run(engine.api.default.approveMCPConsentRequest({ payload: { request: action.request, scope: action.scope, tenant_id: engine.tenantId } })) : await run(engine.api.default.denyMCPConsentRequest({ payload: { request: action.request } }));
  return { redirectUrl: result.redirect_url };
}

export async function connectionsPage(engine: Engine): Promise<ConnectionsDTO> {
  const result = await run(engine.api.default.listMCPConnections({ params: { tenant_id: engine.tenantId } }));
  return { connections: result.data.map((row) => ({ id: row.id, clientName: row.client_name, scope: bundle(row.scope), lastUsedAt: row.last_used_at, createdAt: row.created_at })) };
}

export async function connectionsMutation(engine: Engine, action: ConnectionsAction) {
  await run(engine.api.default.revokeMCPConnection({ params: { tenant_id: engine.tenantId, connection_id: Schema.decodeUnknownSync(UUIDSchema)(action.connectionId) } }));
  return { ok: true };
}
