import { previewAudio } from "../../../scripts/dev/dashboard-artifacts.mjs";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

const ARTIFACT_PREFIX = "/__local-dashboard-artifacts";

/** The local config the fixture dashboard runs with, in place of Cloudflare bindings. */
function localBindings(origin) {
  return {
    CHALK_ENVIRONMENT: "local",
    CHALK_API_ORIGIN: process.env.CHALK_DEV_API_ORIGIN || "http://127.0.0.1:8080",
    DASHBOARD_ORIGIN: origin,
    GOOGLE_CLIENT_ID: "local-google",
    GOOGLE_CLIENT_SECRET: "local-google",
    APPLE_SERVICES_ID: "local-apple",
    APPLE_TEAM_ID: "local-apple",
    APPLE_KEY_ID: "local-apple",
    APPLE_PRIVATE_KEY: "local-apple",
    SESSION_SECRET: process.env.CHALK_DEV_DASHBOARD_SESSION_SECRET || randomBytes(32).toString("base64url"),
    DASHBOARD_SERVICE_TOKEN: process.env.CHALK_DEV_DASHBOARD_SERVICE_TOKEN || "web-only-no-dashboard-service",
    DASHBOARD_IDENTITY_PROVIDER: "fixture",
  };
}

async function artifactResponse(url) {
  const artifacts = JSON.parse(await readFile(process.env.CHALK_DEV_DASHBOARD_ARTIFACTS, "utf8"));
  const artifact = artifacts[url.pathname.slice(ARTIFACT_PREFIX.length)];
  return artifact === "preview-audio" ? new Response(previewAudio(), { headers: { "Content-Type": "audio/wav" } }) : artifact ? Response.json(artifact) : new Response("Not found", { status: 404 });
}

async function dashboardResponse(server, incoming, url, bindings) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  const request = new Request(url, { method: incoming.method, headers: incoming.headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
  const { onRequest } = await server.ssrLoadModule("/tests/dashboard/fixture-entry.ts");
  return onRequest({ request, env: bindings });
}

async function send(outgoing, response) {
  outgoing.statusCode = response.status;
  for (const [name, value] of response.headers) if (name !== "set-cookie") outgoing.setHeader(name, value);
  const cookies = response.headers.getSetCookie();
  if (cookies.length) outgoing.setHeader("Set-Cookie", cookies);
  outgoing.setHeader("Cache-Control", "no-store");
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

/** Installed only by local-dev.mjs, not by an environment switch in deployed code. */
export function localDashboard() {
  const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.CHALK_DEV_WEB_PORT || "3070"}`;
  const bindings = localBindings(origin);
  return {
    name: "local-dashboard",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (incoming, outgoing, next) => {
        const url = new URL(incoming.url, origin);
        // Both sign-in buttons use the Google-shaped local fixture, not a real IdP.
        if (url.pathname === "/auth/start" && url.searchParams.get("provider") === "apple") url.searchParams.set("provider", "google");
        const dashboard = url.pathname.startsWith("/auth/") || url.pathname.startsWith("/dashboard-api/") || url.pathname === "/fixture/authorize";
        if (!dashboard && !url.pathname.startsWith(`${ARTIFACT_PREFIX}/`)) return next();
        try {
          await send(outgoing, dashboard ? await dashboardResponse(server, incoming, url, bindings) : await artifactResponse(url));
        } catch (error) {
          server.config.logger.error(`Local dashboard: ${error instanceof Error ? error.message : "request failed"}`);
          outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "local_dashboard_unavailable" } }));
        }
      });
    },
  };
}
