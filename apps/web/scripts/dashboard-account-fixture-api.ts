// fallow-ignore-file unused-file
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readBoundedNodeBody } from "./node-request-body";

const host = "127.0.0.1";
const configuredPort = Number(process.env.CHALK_DASHBOARD_FIXTURE_API_PORT ?? "18080");
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65_536 ? configuredPort : 18080;
const accountToken = "local-dashboard-fixture-token";
const account = {
  id: "account_fixture_01",
  name: "Hasan Shoaib",
  email: "hasan@example.com",
  updated_at: "2026-08-04T00:00:00Z",
  created_at: "2026-08-04T00:00:00Z",
};
let accountTenants: unknown[] = [];

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok" });
    if (request.method === "POST" && ["/v1/auth/register", "/v1/auth/login"].includes(url.pathname)) {
      await readJSON(request);
      return send(response, 200, {
        user: account,
        session_token: accountToken,
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    }
    if (!authenticated(request)) return send(response, 401, { error: { code: "unauthenticated", message: "Authentication required" } });
    if (request.method === "POST" && url.pathname === "/v1/auth/logout") return sendEmpty(response, 204);
    if (request.method === "GET" && url.pathname === "/v1/me") return send(response, 200, account);
    if (request.method === "GET" && url.pathname === "/v1/regions") {
      return send(response, 200, {
        regions: [
          { code: "us", name: "United States" },
          { code: "eu", name: "Europe" },
          { code: "ap", name: "Asia Pacific" },
        ],
      });
    }
    if (request.method === "GET" && url.pathname === "/v1/me/tenants") return send(response, 200, { tenants: accountTenants });
    if (request.method === "POST" && url.pathname === "/v1/me/tenants") {
      const body = await readJSON(request);
      const createdAt = new Date().toISOString();
      const result = {
        tenant: {
          id: "tenant_fixture_01",
          name: stringValue(body.name) || "Acme studio",
          default_region: stringValue(body.default_region) || "us",
          logo_key: null,
          website: null,
          updated_at: createdAt,
          created_at: createdAt,
        },
        access: {
          id: "access_fixture_01",
          tenant_id: "tenant_fixture_01",
          account_id: account.id,
          role: "owner",
          updated_at: createdAt,
          created_at: createdAt,
        },
      };
      accountTenants = [result];
      return send(response, 201, { ...result, replayed: false });
    }
    return send(response, 404, { error: { code: "not_found", message: "Fixture route not found" } });
  } catch {
    return send(response, 400, { error: { code: "invalid_request", message: "Fixture request was invalid" } });
  }
});

server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "dashboard_fixture.ready", origin: `http://${host}:${port}` }));
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

function authenticated(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${accountToken}`;
}

async function readJSON(request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBoundedNodeBody(request, 64 * 1024, "fixture body too large");
  const value: unknown = JSON.parse(new TextDecoder().decode(body));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture body must be an object");
  return value as Record<string, unknown>;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function sendEmpty(response: ServerResponse, status: number): void {
  response.writeHead(status, { "Cache-Control": "no-store" });
  response.end();
}
