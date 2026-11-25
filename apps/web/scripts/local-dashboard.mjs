import { previewAudio } from "../../../scripts/dev/dashboard-artifacts.mjs";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

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

const ARTIFACT_META_SUFFIX = ".chalk-meta.json";

function artifactRoot() {
  return resolve(dirname(process.env.CHALK_DEV_DASHBOARD_ARTIFACTS), "dashboard-artifacts");
}

function artifactPath(pathname) {
  const root = artifactRoot();
  const path = resolve(root, `.${decodeURIComponent(pathname)}`);
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error(`Invalid local artifact path: ${pathname}`);
  return path;
}

function artifactMetadataPath(path) {
  return `${path}${ARTIFACT_META_SUFFIX}`;
}

async function readArtifactMetadata(path) {
  try {
    return JSON.parse(await readFile(artifactMetadataPath(path), "utf8"));
  } catch {
    return {};
  }
}

async function requestBody(incoming) {
  const chunks = [];
  for await (const chunk of incoming) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function metadataHeaders(incoming) {
  const result = {};
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (name.toLowerCase().startsWith("x-amz-meta-") && typeof value === "string") result[name.toLowerCase().slice("x-amz-meta-".length)] = value;
  }
  return result;
}

function artifactContentType(path, stored) {
  if (stored.contentType) return stored.contentType;
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

function artifactObjectHeaders(path, file, stored) {
  const headers = {
    "Content-Type": artifactContentType(path, stored),
    "Content-Length": String(file.byteLength),
    ETag: stored.etag || createHash("md5").update(file).digest("hex"),
    "Last-Modified": new Date().toUTCString(),
  };
  if (stored.checksumSHA256) headers["x-amz-checksum-sha256"] = stored.checksumSHA256;
  for (const [name, value] of Object.entries(stored.metadata ?? {})) headers[`x-amz-meta-${name}`] = value;
  return headers;
}

async function artifactResponse(url, incoming) {
  const path = artifactPath(url.pathname);
  if (incoming.method === "PUT") {
    if (incoming.headers["if-none-match"] === "*") {
      const exists = await stat(path).then(
        () => true,
        () => false,
      );
      if (exists) return new Response("Precondition failed", { status: 412 });
    }
    const body = await requestBody(incoming);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    const stored = {
      contentType: incoming.headers["content-type"] || artifactContentType(path, {}),
      metadata: metadataHeaders(incoming),
      checksumSHA256: incoming.headers["x-amz-checksum-sha256"] || "",
      etag: createHash("md5").update(body).digest("hex"),
    };
    await writeFile(artifactMetadataPath(path), JSON.stringify(stored));
    return new Response(null, { headers: { ETag: stored.etag } });
  }
  if (incoming.method === "DELETE") {
    await rm(path, { force: true });
    await rm(artifactMetadataPath(path), { force: true });
    return new Response(null, { status: 204 });
  }
  if (incoming.method !== "GET" && incoming.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  const file = await readFile(path).catch(() => null);
  const artifacts = JSON.parse(await readFile(process.env.CHALK_DEV_DASHBOARD_ARTIFACTS, "utf8"));
  const artifact = artifacts[url.pathname.slice(ARTIFACT_PREFIX.length)];
  if (file) {
    const stored = await readArtifactMetadata(path);
    if (Object.keys(stored).length > 0 || artifact === undefined) {
      return new Response(incoming.method === "HEAD" ? null : file, { headers: artifactObjectHeaders(path, file, stored) });
    }
  }
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
          await send(outgoing, dashboard ? await dashboardResponse(server, incoming, url, bindings) : await artifactResponse(url, incoming));
        } catch (error) {
          server.config.logger.error(`Local dashboard: ${error instanceof Error ? error.message : "request failed"}`);
          outgoing.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: { code: "local_dashboard_unavailable" } }));
        }
      });
    },
  };
}
