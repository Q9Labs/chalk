import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocketServer } from "ws";

const tenantAPIKey = process.env.CHALK_API_KEY;
if (!tenantAPIKey || !/^chalk_sk_[^.]+\.[A-Za-z0-9_-]+$/u.test(tenantAPIKey)) throw new TypeError("A canonical CHALK_API_KEY is required by the fixture backend");

const syncServer = new WebSocketServer({ noServer: true });
const mediaServer = new WebSocketServer({ noServer: true });
const syncSockets = new Map();
const mediaSockets = new Map();
const participants = new Map();
const publications = new Map();
const connectionIds = new Map();
const metrics = { accessRequests: 0, syncConnections: 0, mediaConnections: 0, accessReasons: [], mediaReplacements: 0 };
const socketServers = new Map([
  ["/sync", { audience: "chalk-sync", server: syncServer }],
  ["/media", { audience: "chalk-media", server: mediaServer }],
]);
const mediaMessageHandlers = new Map([
  ["signal", relaySignal],
  ["publications", updatePublications],
]);
const syncCommandHandlers = new Map([
  ["participant_leave", leaveParticipant],
  ["remove_participant", removeParticipant],
]);
let revision = 0;

const httpRoutes = new Map([
  ["GET /", serveHTML],
  ["GET /bundle.js", serveBundle],
  ["GET /test/login", logIn],
  ["POST /api/chalk/access", issueAccess],
  ["GET /test/state", serveState],
  ["POST /test/force-sync", forceSyncFailure],
  ["POST /test/force-media", forceMediaFailure],
]);

const server = createServer((request, response) => void dispatchHTTP(request, response));

server.on("upgrade", handleUpgrade);

async function dispatchHTTP(request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const handler = httpRoutes.get(`${request.method ?? "GET"} ${url.pathname}`);
  if (!handler) return sendJSON(response, 404, { error: "not_found" });
  await handler(request, response, url);
}

function serveHTML(_request, response) {
  send(response, 200, html(), "text/html; charset=utf-8");
}

async function serveBundle(_request, response) {
  send(response, 200, await readFile(resolve("dist/bundle.js")), "text/javascript; charset=utf-8");
}

function logIn(_request, response, url) {
  const user = url.searchParams.get("user");
  if (!user || !/^[a-z]+$/u.test(user)) return sendJSON(response, 400, { error: "invalid_user" });
  response.writeHead(302, { location: "/", "set-cookie": `chalk_fixture_user=${user}; HttpOnly; SameSite=Strict; Path=/` });
  response.end();
}

function serveState(_request, response) {
  sendJSON(response, 200, publicState());
}

function forceSyncFailure(_request, response, url) {
  forceSocket(response, syncSockets, url.searchParams.get("participant"), "close");
}

function forceMediaFailure(_request, response, url) {
  forceSocket(response, mediaSockets, url.searchParams.get("participant"), "message");
}

function handleUpgrade(request, socket, head) {
  const url = new URL(request.url ?? "/", "http://localhost");
  const selected = socketServers.get(url.pathname);
  if (!selected) return socket.destroy();
  const token = tokenForAudience(url.searchParams.get("token"), selected.audience);
  if (!token) return socket.destroy();
  selected.server.handleUpgrade(request, socket, head, (webSocket) => selected.server.emit("connection", webSocket, request, token));
}

function tokenForAudience(value, audience) {
  const payload = tokenPayload(value);
  if (!payload) return null;
  return payload.aud === audience ? payload : null;
}

syncServer.on("connection", (socket, _request, token) => {
  metrics.syncConnections += 1;
  replaceSocket(syncSockets, token.sub, socket);
  if (!participants.has(token.sub)) {
    participants.set(token.sub, participant(token.sub));
    revision += 1;
  }
  broadcastState();
  socket.on("message", (data) => handleSyncCommand(socket, token.sub, JSON.parse(String(data))));
  socket.on("close", () => {
    if (syncSockets.get(token.sub) === socket) syncSockets.delete(token.sub);
  });
});

mediaServer.on("connection", (socket, _request, token) => {
  metrics.mediaConnections += 1;
  replaceSocket(mediaSockets, token.sub, socket);
  broadcastPeers();
  socket.on("message", (data) => handleMediaMessage(token.sub, JSON.parse(String(data))));
  socket.on("close", () => {
    if (mediaSockets.get(token.sub) === socket) mediaSockets.delete(token.sub);
    clearPublications(token.sub);
    broadcastPeers();
    broadcastState();
  });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new TypeError("Fixture server did not bind a TCP port");
  process.stdout.write(`${JSON.stringify({ type: "listening", url: `http://localhost:${address.port}` })}\n`);
});

async function issueAccess(request, response) {
  metrics.accessRequests += 1;
  const user = cookie(request.headers.cookie ?? "", "chalk_fixture_user");
  if (!canIssueAccess(user)) return sendJSON(response, 403, { error: "access_denied" });
  const body = await readJSON(request);
  const reason = accessReason(body);
  metrics.accessReasons.push(reason);
  const replaceMedia = body.replaceMediaConnection === true;
  const connectionId = mediaConnectionId(user, replaceMedia);
  if (replaceMedia) metrics.mediaReplacements += 1;
  connectionIds.set(user, connectionId);
  const expiresAt = accessExpiration(reason);
  return sendJSON(response, 200, {
    subject: { tenantId: "fixture-tenant", roomId: "fixture-room", sessionId: "fixture-session", participantSessionId: user, participantGeneration: 1 },
    sync: { token: token("chalk-sync", user), expiresAt },
    media: { token: token("chalk-media", user), expiresAt, provider: "cloudflare_sfu", clientPayload: { connectionId, stunServer: "stun:localhost:9" } },
  });
}

function canIssueAccess(user) {
  if (!user) return false;
  return user !== "denied";
}

function accessReason(body) {
  return typeof body.reason === "string" ? body.reason : "join";
}

function mediaConnectionId(user, replaceMedia) {
  if (replaceMedia) return newConnectionId(user);
  return connectionIds.get(user) ?? newConnectionId(user);
}

function newConnectionId(user) {
  return `${user}-connection-${crypto.randomUUID()}`;
}

function accessExpiration(reason) {
  const lifetime = reason === "join" ? 1_300 : 300_000;
  return new Date(Date.now() + lifetime).toISOString();
}

function handleSyncCommand(socket, actor, message) {
  if (message.type !== "command" || typeof message.id !== "string") return;
  const handler = syncCommandHandlers.get(message.name) ?? acknowledgeCommand;
  handler(socket, actor, message);
}

function leaveParticipant(socket, actor, message) {
  socket.send(JSON.stringify({ type: "ack", id: message.id }));
  participants.delete(actor);
  clearPublications(actor);
  revision += 1;
  broadcastState();
  broadcastPeers();
}

function removeParticipant(socket, _actor, message) {
  const target = message.payload?.participantSessionId;
  if (typeof target === "string") removeParticipantState(target);
  acknowledgeCommand(socket, _actor, message);
}

function removeParticipantState(target) {
  participants.delete(target);
  clearPublications(target);
  revision += 1;
  broadcastState();
}

function acknowledgeCommand(socket, _actor, message) {
  socket.send(JSON.stringify({ type: "ack", id: message.id }));
}

function handleMediaMessage(actor, message) {
  mediaMessageHandlers.get(message.type)?.(actor, message);
}

function relaySignal(actor, message) {
  if (typeof message.to !== "string") return;
  const target = mediaSockets.get(message.to);
  if (target && target.readyState === target.OPEN) target.send(JSON.stringify({ type: "signal", from: actor, description: message.description, candidate: message.candidate, mids: message.mids }));
}

function updatePublications(actor, message) {
  if (!Array.isArray(message.publications)) return;
  clearPublications(actor);
  for (const item of message.publications) updatePublication(actor, item);
  revision += 1;
  broadcastState();
}

function updatePublication(actor, item) {
  if (!isActorPublication(actor, item)) return;
  publications.set(`${actor}:${item.source}`, { participantSessionId: actor, source: item.source, enabled: item.enabled === true, publicationId: item.enabled ? String(item.publicationId) : null });
}

function isActorPublication(actor, item) {
  if (!item) return false;
  if (item.participantSessionId !== actor) return false;
  return ["microphone", "camera", "screen"].includes(item.source);
}

function broadcastState() {
  const message = JSON.stringify({ type: "state", state: meetingState() });
  for (const socket of [...syncSockets.values(), ...mediaSockets.values()]) if (socket.readyState === socket.OPEN) socket.send(message);
}

function broadcastPeers() {
  const message = JSON.stringify({ type: "peers", participants: [...mediaSockets.keys()].sort() });
  for (const socket of mediaSockets.values()) if (socket.readyState === socket.OPEN) socket.send(message);
}

function meetingState() {
  return { revision, participants: [...participants.values()].sort((a, b) => a.participantSessionId.localeCompare(b.participantSessionId)), publications: [...publications.values()] };
}

function publicState() {
  return {
    metrics: { ...metrics },
    activeParticipants: [...participants.keys()],
    sockets: { sync: syncSockets.size, media: mediaSockets.size },
    publications: [...publications.values()],
    tenantCredentialExposed: false,
  };
}

function participant(id) {
  return { participantSessionId: id, displayName: id, handRaised: false, admissionRevision: 1, role: id === "alice" ? "host" : "participant", eligibleRoles: ["host", "cohost", "participant"], capabilities: ["publishAudio", "publishVideo", "publishScreen", "subscribe", "removeParticipant"] };
}

function forceSocket(response, collection, participantId, operation) {
  const socket = participantId ? collection.get(participantId) : null;
  if (!socket) return sendJSON(response, 404, { error: "participant_not_connected" });
  if (operation === "close") socket.close(4101, "fixture_forced_sync_failure");
  else socket.send(JSON.stringify({ type: "force_failure" }));
  return sendJSON(response, 202, { accepted: true });
}

function replaceSocket(collection, participantId, socket) {
  collection.get(participantId)?.close(4000, "fixture_replaced");
  collection.set(participantId, socket);
}

function clearPublications(participantId) {
  for (const key of publications.keys()) if (key.startsWith(`${participantId}:`)) publications.delete(key);
}

function token(audience, subject) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({ aud: audience, sub: subject })}.fixture`;
}

function tokenPayload(value) {
  try {
    const payload = JSON.parse(Buffer.from(String(value).split(".")[1] ?? "", "base64url").toString("utf8"));
    return validTokenPayload(payload);
  } catch {
    return null;
  }
}

function validTokenPayload(payload) {
  if (!isObject(payload)) return null;
  if (typeof payload.aud !== "string") return null;
  if (typeof payload.sub !== "string") return null;
  return payload;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object";
}

function cookie(header, name) {
  return (
    header
      .split(";")
      .map((item) => item.trim().split("="))
      .find(([key]) => key === name)?.[1] ?? null
  );
}

async function readJSON(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJSON(response, status, body) {
  return send(response, status, JSON.stringify(body), "application/json; charset=utf-8");
}

function send(response, status, body, contentType) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

function html() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>Packed Chalk consumer</title></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>';
}

function shutdown() {
  for (const socket of [...syncSockets.values(), ...mediaSockets.values()]) socket.close();
  server.close(() => process.exit(0));
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
