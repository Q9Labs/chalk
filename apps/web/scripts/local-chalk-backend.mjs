import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const bindAddress = "127.0.0.1";
const cookieName = "chalk_local_session";
const maximumBodyBytes = 8_192;

export function createLocalChalkHandler(options) {
  const browserSessions = new Map();
  const allowedOrigins = new Set(options.allowedOrigins);
  let sharedRoomPromise;

  return async function localChalkHandler(request, response) {
    setPrivateResponseHeaders(response);

    const url = new URL(request.url ?? "/", "http://localhost");
    if (!isLocalAddress(request.socket.remoteAddress) || !isLocalHost(request.headers.host) || !allowedOrigins.has(request.headers.origin ?? "")) {
      return json(response, 403, { error: "The local Chalk backend only accepts requests from its localhost web app." });
    }
    if (request.method !== "POST") return json(response, 405, { error: "Method not allowed." }, { allow: "POST" });

    try {
      if (url.pathname === "/local-chalk/browser-session") {
        const body = await readJSON(request);
        const displayName = presentationName(body);
        const browserSessionId = options.randomUUID();
        browserSessions.set(browserSessionId, {
          displayName,
          admissionPromise: undefined,
          roomId: undefined,
          sessionId: undefined,
          participantSessionId: undefined,
          participantSessionGeneration: undefined,
        });
        response.setHeader("set-cookie", sessionCookie(browserSessionId));
        return json(response, 201, {
          apiBaseURL: options.apiBaseURL,
          syncURL: options.syncURL,
        });
      }

      const browserSessionId = cookieValue(request.headers.cookie, cookieName);
      const browserSession = browserSessionId ? browserSessions.get(browserSessionId) : undefined;
      if (!browserSession) return json(response, 401, { error: "The local browser session is missing or expired." });

      if (url.pathname === "/local-chalk/access") {
        const body = await readJSON(request);
        const input = accessInput(body);
        const access = browserSession.admissionPromise || browserSession.participantSessionGeneration === undefined ? await admitBrowserSession(browserSession) : await refreshBrowserSession(browserSession, input);
        return json(response, 201, access);
      }

      if (url.pathname === "/local-chalk/cleanup") {
        browserSessions.delete(browserSessionId);
        response.setHeader("set-cookie", expiredSessionCookie());
        response.statusCode = 204;
        return response.end();
      }

      return json(response, 404, { error: "Not found." });
    } catch (error) {
      const status = error instanceof LocalBackendError ? error.status : 502;
      const message = error instanceof LocalBackendError ? error.message : "The local Chalk backend could not complete the request.";
      options.log?.("request_failed", { method: request.method, path: url.pathname, status });
      return json(response, status, { error: message });
    }
  };

  function ensureSharedRoom() {
    if (!sharedRoomPromise) {
      sharedRoomPromise = createSharedRoom(options.chalk, options.randomUUID).catch((error) => {
        sharedRoomPromise = undefined;
        throw error;
      });
    }
    return sharedRoomPromise;
  }

  function admitBrowserSession(browserSession) {
    if (browserSession.admissionPromise) return browserSession.admissionPromise;
    browserSession.admissionPromise = (async () => {
      const sharedRoom = await ensureSharedRoom();
      const participantSessionId = browserSession.participantSessionId ?? options.randomUUID();
      browserSession.roomId = sharedRoom.roomId;
      browserSession.sessionId = sharedRoom.sessionId;
      browserSession.participantSessionId = participantSessionId;
      const admission = await options.chalk.participants.admit(
        sharedRoom.roomId,
        sharedRoom.sessionId,
        {
          participant_session_id: participantSessionId,
          name: browserSession.displayName,
          initial_role: "participant",
          eligible_roles: ["participant", "cohost"],
        },
        { idempotencyKey: `local-browser-${participantSessionId}` },
      );
      browserSession.participantSessionGeneration = admission.participant.generation;
      if (admission.access) return admission.access;
      return refreshBrowserSession(browserSession, { replaceMediaConnection: false });
    })().finally(() => {
      browserSession.admissionPromise = undefined;
    });
    return browserSession.admissionPromise;
  }

  function refreshBrowserSession(browserSession, input) {
    return options.chalk.participants.issueAccess(browserSession.roomId, browserSession.sessionId, browserSession.participantSessionId, {
      participantSessionGeneration: browserSession.participantSessionGeneration,
      ...input,
    });
  }
}

async function startLocalChalkBackend(environment = process.env) {
  const apiKey = requiredEnvironment(environment, "CHALK_API_KEY");
  const tenantId = requiredEnvironment(environment, "CHALK_TENANT_ID");
  const apiBaseURL = environment.CHALK_API_URL ?? "http://127.0.0.1:8080";
  const syncURL = environment.CHALK_SYNC_URL ?? "ws://127.0.0.1:4100/v3/sync";
  const port = integerPort(environment.CHALK_LOCAL_BACKEND_PORT ?? "3071");
  const allowedOrigins = environment.CHALK_WEB_ORIGIN ? [environment.CHALK_WEB_ORIGIN] : ["http://127.0.0.1:3070", "http://localhost:3070"];
  const { createChalkServerClient } = await import("@q9labsai/chalk-client/server");
  const chalk = createChalkServerClient({ apiKey, tenantId, apiBaseURL });
  const handler = createLocalChalkHandler({
    chalk,
    apiBaseURL,
    syncURL,
    allowedOrigins,
    randomUUID: () => crypto.randomUUID(),
    log: (event, fields) => console.error(`[chalk-local-bff] ${event}`, fields),
  });
  const server = createServer((request, response) => void handler(request, response));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, bindAddress, resolve);
  });
  console.info(`[chalk-local-bff] listening on http://${bindAddress}:${port}`);
  return server;
}

async function createSharedRoom(chalk, randomUUID) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const room = await chalk.rooms.create({
    name: "Local SDK verification room",
    slug: `local-sdk-${suffix}`,
    status: "active",
    media_plane: "cf_sfu",
  });
  const session = await chalk.sessions.create(
    room.id,
    {
      admission_policy: "open",
      host_exit_policy: "require_transfer",
      maximum_duration_seconds: 3_600,
      role_capabilities: {
        host: allCapabilities,
        cohost: participantCapabilities,
        participant: participantCapabilities,
      },
    },
    { idempotencyKey: `local-session-${suffix}` },
  );
  return { roomId: room.id, sessionId: session.id };
}

const participantCapabilities = ["publishAudio", "publishVideo", "publishScreen", "subscribe", "raiseHand", "renameSelf"];
const allCapabilities = [...participantCapabilities, "manageAdmission", "promoteDemote", "transferHost", "muteOthers", "stopVideoOthers", "stopScreenOthers", "requestMediaOthers", "removeParticipant", "endMeeting"];

function presentationName(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "displayName")) throw new LocalBackendError(400, "Only displayName is accepted.");
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (!displayName || displayName.length > 80) throw new LocalBackendError(400, "Display name must be between 1 and 80 characters.");
  return displayName;
}

function accessInput(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "currentMediaToken" && key !== "replaceMediaConnection")) {
    throw new LocalBackendError(400, "The access refresh request is invalid.");
  }
  const replaceMediaConnection = value.replaceMediaConnection ?? false;
  if (typeof replaceMediaConnection !== "boolean") throw new LocalBackendError(400, "replaceMediaConnection must be a boolean.");
  if (value.currentMediaToken !== undefined && (typeof value.currentMediaToken !== "string" || value.currentMediaToken.length > 8_192)) {
    throw new LocalBackendError(400, "currentMediaToken is invalid.");
  }
  return {
    replaceMediaConnection,
    ...(typeof value.currentMediaToken === "string" ? { currentMediaToken: value.currentMediaToken } : {}),
  };
}

async function readJSON(request) {
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) throw new LocalBackendError(415, "Content-Type must be application/json.");
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBodyBytes) throw new LocalBackendError(413, "Request body is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new LocalBackendError(400, "Request body must be valid JSON.");
  }
}

function setPrivateResponseHeaders(response) {
  response.setHeader("cache-control", "no-store");
  response.setHeader("pragma", "no-cache");
  response.setHeader("x-content-type-options", "nosniff");
}

function json(response, status, body, headers = {}) {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(body));
}

function sessionCookie(value) {
  return `${cookieName}=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/local-chalk`;
}

function expiredSessionCookie() {
  return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/local-chalk; Max-Age=0`;
}

function cookieValue(header, name) {
  for (const pair of header?.split(";") ?? []) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function isLocalHost(host) {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.username === "" && parsed.password === "" && parsed.pathname === "/" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function isLocalAddress(address) {
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1" || address === "::1";
}

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required by the local Chalk backend.`);
  return value;
}

function integerPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("CHALK_LOCAL_BACKEND_PORT must be a valid TCP port.");
  return port;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class LocalBackendError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startLocalChalkBackend().catch((error) => {
    console.error("[chalk-local-bff] startup failed", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });
}
