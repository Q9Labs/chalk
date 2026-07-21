import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";

const host = "127.0.0.1";
const port = requiredPort("CHALK_CLOUDFLARE_SFU_STUB_PORT");
const appId = required("CHALK_CLOUDFLARE_SFU_STUB_APP_ID");
const appSecret = required("CHALK_CLOUDFLARE_SFU_STUB_APP_SECRET");
const requestLog = required("CHALK_CLOUDFLARE_SFU_STUB_REQUEST_LOG");
let nextSession = 1;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${host}:${port}`);
    if (request.method === "GET" && url.pathname === "/readyz") {
      return json(response, 200, { status: "ready" });
    }

    if (request.headers.authorization !== `Bearer ${appSecret}`) {
      return json(response, 401, { errors: [{ message: "authentication failed" }] });
    }

    const appPrefix = `/v1/apps/${encodeURIComponent(appId)}`;
    if (!url.pathname.startsWith(`${appPrefix}/`)) {
      return json(response, 404, { errors: [{ message: "application not found" }] });
    }

    await appendFile(requestLog, `${JSON.stringify({ method: request.method, path: url.pathname, received_at: new Date().toISOString() })}\n`, { mode: 0o600 });

    if (request.method === "POST" && url.pathname === `${appPrefix}/sessions/new`) {
      await readJSON(request);
      return json(response, 200, { sessionId: `local-sfu-session-${nextSession++}` });
    }

    const sessionPath = url.pathname.slice(`${appPrefix}/sessions/`.length);
    if (request.method === "GET" && sessionPath && !sessionPath.includes("/")) {
      return json(response, 200, {});
    }
    if (request.method === "POST" && sessionPath.endsWith("/tracks/new")) {
      const body = await readJSON(request);
      return json(response, 200, {
        sessionDescription: body.sessionDescription ? { type: "answer", sdp: "local-observability-answer" } : undefined,
        tracks: Array.isArray(body.tracks) ? body.tracks : [],
      });
    }
    if (request.method === "PUT" && sessionPath.endsWith("/tracks/close")) {
      const body = await readJSON(request);
      return json(response, 200, {
        tracks: Array.isArray(body.tracks) ? body.tracks.map(({ mid }) => ({ mid })) : [],
        requiresImmediateRenegotiation: false,
      });
    }
    if (request.method === "PUT" && sessionPath.endsWith("/renegotiate")) {
      await readJSON(request);
      return json(response, 200, {});
    }

    return json(response, 404, { errors: [{ message: "session operation not found" }] });
  } catch (error) {
    return json(response, error?.code === "PAYLOAD_TOO_LARGE" ? 413 : 400, {
      errors: [{ message: "invalid request" }],
    });
  }
});

server.listen(port, host);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

async function readJSON(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      const error = new Error("payload too large");
      error.code = "PAYLOAD_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredPort(name) {
  const value = Number.parseInt(required(name), 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a valid port`);
  }
  return value;
}
