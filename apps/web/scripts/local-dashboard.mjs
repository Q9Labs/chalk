import { previewAudio } from "../../../scripts/dev/dashboard-artifacts.mjs";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

export function artifactObjectHeaders(path, file, stored) {
  const headers = {
    "Content-Type": artifactContentType(path, stored),
    "Content-Disposition": "attachment",
    "X-Content-Type-Options": "nosniff",
    "Content-Length": String(file.byteLength),
    ETag: stored.etag || createHash("md5").update(file).digest("hex"),
    "Last-Modified": new Date().toUTCString(),
  };
  if (stored.checksumSHA256) headers["x-amz-checksum-sha256"] = stored.checksumSHA256;
  for (const [name, value] of Object.entries(stored.metadata ?? {})) headers[`x-amz-meta-${name}`] = value;
  return headers;
}


const ARTIFACT_ACCESS_KEY = "local-dashboard";
const ARTIFACT_SECRET = "local-dashboard-storage-not-a-production-secret";

function awsEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function artifactSignatureSecret() {
  return process.env.CHALK_LOCAL_ARTIFACT_SIGNING_SECRET || ARTIFACT_SECRET;
}

function artifactSignatureAccessKey() {
  return process.env.CHALK_LOCAL_ARTIFACT_SIGNING_ACCESS_KEY || ARTIFACT_ACCESS_KEY;
}

function artifactCanonicalHeader(incoming, name) {
  if (name === "host") return incoming.headers.host || "";
  const value = incoming.headers[name];
  if (Array.isArray(value)) return value.join(",");
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

export function artifactSignatureValid(method, url, incoming, now = new Date()) {
  const algorithm = url.searchParams.get("X-Amz-Algorithm");
  const credential = url.searchParams.get("X-Amz-Credential");
  const date = url.searchParams.get("X-Amz-Date");
  const expires = Number(url.searchParams.get("X-Amz-Expires"));
  const signedHeaders = url.searchParams.get("X-Amz-SignedHeaders");
  const signature = url.searchParams.get("X-Amz-Signature");
  if (algorithm !== "AWS4-HMAC-SHA256" || !credential || !date || !Number.isInteger(expires) || expires < 1 || !signedHeaders || !/^[a-f0-9]{64}$/.test(signature || "")) return false;
  const [accessKey, day, region, service, terminator] = credential.split("/");
  if (accessKey !== artifactSignatureAccessKey() || !day || !region || service !== "s3" || terminator !== "aws4_request" || !date.startsWith(day)) return false;
  const signedAt = Date.parse(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`);
  if (!Number.isFinite(signedAt) || now.getTime() < signedAt - 60_000 || now.getTime() > signedAt + expires * 1000) return false;
  const headerNames = signedHeaders.split(";").sort();
  const canonicalHeaders = `${headerNames.map((name) => `${name}:${artifactCanonicalHeader(incoming, name)}\n`).join("")}`;
  const query = [...url.searchParams.entries()]
    .filter(([name]) => name !== "X-Amz-Signature")
    .sort(([leftName, leftValue], [rightName, rightValue]) => leftName === rightName ? (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0) : (leftName < rightName ? -1 : 1))
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join("&");
  const canonicalRequest = [method, url.pathname, query, canonicalHeaders, headerNames.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", date, scope, sha256Hex(canonicalRequest)].join("\n");
  const dateKey = hmac(`AWS4${artifactSignatureSecret()}`, day);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, "s3");
  const signingKey = hmac(serviceKey, "aws4_request");
  const expected = createHmac("sha256", signingKey).update(stringToSign).digest();
  const actual = Buffer.from(signature, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function artifactResponse(url, incoming) {
  const path = artifactPath(url.pathname);
  if (incoming.method === "PUT") {
    if (!artifactSignatureValid("PUT", url, incoming)) return new Response("Forbidden", { status: 403 });
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
    if (!artifactSignatureValid("DELETE", url, incoming)) return new Response("Forbidden", { status: 403 });
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
