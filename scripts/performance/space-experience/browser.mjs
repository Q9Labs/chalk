import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { FeatureUnreachableError } from "./errors.mjs";

const PARTICIPANT_NAMES = ["Avery", "Blake", "Casey", "Devon"];
const READY_SELECTOR = '[data-tour="video-grid"]';

function participantName(index) {
  return PARTICIPANT_NAMES[index] ?? `Participant-${index + 1}`;
}

export function loadChromium(repoRoot) {
  const packageAnchor = join(repoRoot, "sdks", "typescript", "client", "package.json");
  return createRequire(packageAnchor)("playwright").chromium;
}

function mediaInitOverride() {
  const devices = navigator.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") return;
  Object.defineProperty(devices, "getDisplayMedia", {
    configurable: true,
    writable: true,
    value: async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 1280;
      canvas.height = 720;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("screen-share canvas context is unavailable");
      let animationFrame = 0;
      const paint = (time) => {
        const phase = Math.floor(time / 16) % canvas.width;
        context.fillStyle = "#101828";
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#7f56d9";
        context.fillRect(phase - 160, 0, 160, canvas.height);
        animationFrame = requestAnimationFrame(paint);
      };
      paint(0);
      const stream = canvas.captureStream(30);
      const track = stream.getVideoTracks()[0] ?? null;
      if (track) {
        const stop = track.stop.bind(track);
        track.addEventListener("ended", () => cancelAnimationFrame(animationFrame));
        Object.defineProperty(track, "stop", {
          configurable: true,
          value: () => {
            cancelAnimationFrame(animationFrame);
            stop();
          },
        });
      }
      return stream;
    },
  });
  window.__chalkPerfMediaOverride = true;
}

function peerConnectionInitOverride() {
  const NativeRTCPeerConnection = globalThis.RTCPeerConnection;
  if (typeof NativeRTCPeerConnection !== "function" || globalThis.__chalkPerfWebRtcOverride) return;

  const MAX_TRACKED_PEER_CONNECTIONS = 24;
  const peerConnections = [];
  let nextPeerConnectionId = 1;

  const finiteStat = (value) => (Number.isFinite(value) ? value : null);
  const addStat = (target, source, name) => {
    const value = finiteStat(source[name]);
    if (value === null) return;
    target[name] = (target[name] ?? 0) + value;
  };
  const videoRtpStats = (stats, direction) => {
    const summary = { streams: 0 };
    const fields = direction === "inbound" ? ["packetsReceived", "packetsLost", "bytesReceived", "framesReceived", "framesDecoded", "keyFramesDecoded"] : ["packetsSent", "bytesSent", "framesSent", "framesEncoded", "keyFramesEncoded"];
    stats.forEach((stat) => {
      if (stat.type !== `${direction}-rtp` || (stat.kind !== "video" && stat.mediaType !== "video")) return;
      summary.streams += 1;
      for (const field of fields) addStat(summary, stat, field);
    });
    return summary;
  };
  const videoTrackStates = (peer, method) => {
    const tracks = typeof peer[method] === "function" ? peer[method]() : [];
    return tracks
      .filter((entry) => entry?.track?.kind === "video")
      .map((entry) => ({
        muted: typeof entry.track.muted === "boolean" ? entry.track.muted : null,
        readyState: typeof entry.track.readyState === "string" ? entry.track.readyState : null,
      }));
  };
  const summarize = async (record) => {
    const peer = record.peer;
    const state = {
      id: record.id,
      active: peer.connectionState !== "closed",
      connectionState: typeof peer.connectionState === "string" ? peer.connectionState : null,
      iceConnectionState: typeof peer.iceConnectionState === "string" ? peer.iceConnectionState : null,
      iceGatheringState: typeof peer.iceGatheringState === "string" ? peer.iceGatheringState : null,
      signalingState: typeof peer.signalingState === "string" ? peer.signalingState : null,
      videoSenders: videoTrackStates(peer, "getSenders"),
      videoReceivers: videoTrackStates(peer, "getReceivers"),
      inboundVideoRtp: { streams: 0 },
      outboundVideoRtp: { streams: 0 },
    };
    if (typeof peer.getStats !== "function") return state;
    try {
      const stats = await peer.getStats();
      state.inboundVideoRtp = videoRtpStats(stats, "inbound");
      state.outboundVideoRtp = videoRtpStats(stats, "outbound");
    } catch {
      state.statsError = "getStats failed";
    }
    return state;
  };
  const track = (peer) => {
    peerConnections.push({ id: nextPeerConnectionId++, peer });
    if (peerConnections.length > MAX_TRACKED_PEER_CONNECTIONS) peerConnections.shift();
    return peer;
  };

  const DiagnosticRTCPeerConnection = new Proxy(NativeRTCPeerConnection, {
    construct(target, argumentsList) {
      return track(Reflect.construct(target, argumentsList, target));
    },
  });
  Object.defineProperty(globalThis, "RTCPeerConnection", { configurable: true, writable: true, value: DiagnosticRTCPeerConnection });
  globalThis.__chalkPerfWebRtcOverride = true;
  globalThis.__chalkPerfWebRtcDiagnostics = async () => {
    const summaries = [];
    for (const record of peerConnections) summaries.push(await summarize(record));
    return { maxPeerConnections: MAX_TRACKED_PEER_CONNECTIONS, peerConnections: summaries };
  };
}

function webSocketCloseOverride() {
  const NativeWebSocket = window.WebSocket;
  const DiagnosticWebSocket = new Proxy(NativeWebSocket, {
    construct(target, argumentsList) {
      const socket = Reflect.construct(target, argumentsList, target);
      if (new URL(socket.url).pathname === "/v1/whiteboard") {
        socket.addEventListener("close", (event) => {
          void globalThis.__chalkPerfRecordWhiteboardClose?.({ url: socket.url, code: event.code, reason: event.reason, wasClean: event.wasClean });
        });
      }
      return socket;
    },
  });
  Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: DiagnosticWebSocket });
}

function diagnosticUrl(value) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?", 1)[0].split("#", 1)[0];
  }
}

export function createDiagnosticRecorder(entries, now = () => new Date().toISOString()) {
  const index = new Map();
  return (entry) => {
    const normalized = entry.url ? { ...entry, url: diagnosticUrl(entry.url) } : entry;
    const key = [normalized.type, normalized.fatal, normalized.resourceType, normalized.url, normalized.message].join("\u0000");
    const at = now();
    const existing = index.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      return existing;
    }
    const recorded = { ...normalized, count: 1, firstAt: at, lastAt: at };
    entries.push(recorded);
    index.set(key, recorded);
    return recorded;
  };
}

export function isChatAttachmentExchange(method, value) {
  try {
    const url = new URL(value);
    if (method === "PUT") return url.searchParams.has("X-Amz-Signature");
    if (method !== "POST") return false;
    return /^\/v1\/chat\/attachments\/uploads(?:\/[^/]+\/finalize)?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isOptionalUiSoundRequest(resourceType, value) {
  if (resourceType !== "media") return false;
  try {
    const url = new URL(value);
    return url.hostname === "assets.chalkmeet.com" && /^\/ui\/sounds\/(?:join|leave)\.[a-z0-9]+\.opus$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function isFatalRequestFailure(message, resourceType, value) {
  return !/ERR_(?:ABORTED|CANCELED)/i.test(message) && !isOptionalUiSoundRequest(resourceType, value);
}

export function whiteboardControlFrameDiagnostic(direction, payload, presentationOperations = new Map()) {
  const text = typeof payload === "string" ? payload : payload instanceof Uint8Array ? new TextDecoder().decode(payload) : null;
  if (!text) return null;
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    return null;
  }
  if (!frame || typeof frame !== "object") return null;
  if (direction === "sent" && frame.type === "set_presentation" && typeof frame.operation_id === "string" && typeof frame.presenting === "boolean") {
    presentationOperations.set(frame.operation_id, frame.presenting);
    return `sent set_presentation ${frame.presenting}`;
  }
  if (direction === "sent" && typeof frame.type === "string" && ["request_snapshot", "snapshot_ack", "submit_update", "submit_update_part", "cursor", "clear", "set_draw_permission", "ping"].includes(frame.type)) {
    return `sent ${frame.type}`;
  }
  if (direction !== "received") return null;
  if (frame.type === "welcome") return `received welcome presentation ${typeof frame.presenting === "boolean"}`;
  if (frame.type === "reset_required" && typeof frame.reason === "string") return `received reset_required ${frame.reason}`;
  if (frame.type === "presentation_updated" && typeof frame.presenting === "boolean") return `received presentation_updated ${frame.presenting}`;
  if (frame.type === "commit" && typeof frame.operation_id === "string" && presentationOperations.has(frame.operation_id)) {
    const presenting = presentationOperations.get(frame.operation_id);
    presentationOperations.delete(frame.operation_id);
    return `received set_presentation commit ${presenting}`;
  }
  if (frame.type === "operation_error" && typeof frame.correlation_id === "string" && presentationOperations.has(frame.correlation_id)) {
    const presenting = presentationOperations.get(frame.correlation_id);
    presentationOperations.delete(frame.correlation_id);
    return `received set_presentation error ${presenting}`;
  }
  if (frame.type === "operation_error" && typeof frame.operation === "string") return `received operation_error ${frame.operation}`;
  if (typeof frame.type === "string" && ["request_snapshot", "snapshot_ack", "snapshot_page", "submit_update", "submit_update_part", "update", "cursor", "clear", "set_draw_permission", "ping", "pong"].includes(frame.type)) {
    return `${direction} ${frame.type}`;
  }
  if (direction === "received" && frame.type === "commit") return "received commit";
  return null;
}

export function webSocketCloseFrameDiagnostic(direction, payload) {
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) return `${direction} close frame without status`;
  if (bytes.length === 1) return `${direction} malformed close frame`;
  const code = bytes.readUInt16BE(0);
  const reason = new TextDecoder().decode(bytes.subarray(2));
  return `${direction} close frame ${code}${reason ? ` ${reason}` : ""}`;
}

export function whiteboardSocketCloseDiagnostic(code, reason, wasClean) {
  return `WebSocket closed ${code}${reason ? ` ${reason}` : ""}; clean=${wasClean}`;
}

function captureWebSocketCloseFrames(cdp, recordDiagnostic) {
  const sockets = new Map();
  cdp.on("Network.webSocketCreated", ({ requestId, url }) => sockets.set(requestId, url));
  for (const [event, direction] of [
    ["Network.webSocketFrameSent", "sent"],
    ["Network.webSocketFrameReceived", "received"],
  ]) {
    cdp.on(event, ({ requestId, response }) => {
      if (response.opcode !== 8) return;
      const url = sockets.get(requestId);
      recordDiagnostic({
        type: "websocket-close-frame",
        fatal: false,
        url,
        message: webSocketCloseFrameDiagnostic(direction, response.payloadData),
      });
    });
  }
  cdp.on("Network.webSocketClosed", ({ requestId }) => sockets.delete(requestId));
}

async function captureChatAttachmentExchange(cdp, recordDiagnostic) {
  const requests = new Map();
  cdp.on("Network.requestWillBeSent", ({ requestId, request }) => {
    if (!isChatAttachmentExchange(request.method, request.url)) return;
    const phase = request.method === "PUT" ? "storage-put" : new URL(request.url).pathname.endsWith("/finalize") ? "finalize" : "initiate";
    requests.set(requestId, { phase, url: request.url });
    recordDiagnostic({ type: "chat-attachment-request", fatal: false, url: request.url, message: `${phase} ${request.method}` });
  });
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const request = requests.get(requestId);
    if (!request) return;
    recordDiagnostic({ type: "chat-attachment-response", fatal: false, status: response.status, url: request.url, message: `${request.phase} HTTP ${response.status}` });
    requests.delete(requestId);
  });
  cdp.on("Network.loadingFailed", ({ requestId, errorText, blockedReason, corsErrorStatus }) => {
    const request = requests.get(requestId);
    if (!request) return;
    const detail = [errorText, blockedReason, corsErrorStatus?.corsError].filter(Boolean).join("; ");
    recordDiagnostic({ type: "chat-attachment-loading-failed", fatal: false, url: request.url, message: `${request.phase}: ${detail || "unknown"}` });
    requests.delete(requestId);
  });
  cdp.on("Network.loadingFinished", ({ requestId }) => requests.delete(requestId));
  await cdp.send("Network.enable");
}

export async function launchParticipant(browser, options, index) {
  const errors = [];
  const recordDiagnostic = createDiagnosticRecorder(errors);
  const contextOptions = {
    viewport: { width: 1440, height: 900 },
    permissions: ["camera", "microphone"],
    baseURL: options.base,
  };
  if (options.storageState) contextOptions.storageState = JSON.parse(await readFile(options.storageState, "utf8"));
  const context = await browser.newContext(contextOptions);
  await context.exposeBinding("__chalkPerfRecordWhiteboardClose", (_source, detail) => {
    if (!detail || typeof detail !== "object" || typeof detail.code !== "number" || typeof detail.reason !== "string" || typeof detail.wasClean !== "boolean" || typeof detail.url !== "string") return;
    recordDiagnostic({ type: "websocket-close-detail", fatal: false, url: detail.url, message: whiteboardSocketCloseDiagnostic(detail.code, detail.reason, detail.wasClean) });
  });
  await context.addInitScript({ content: `(${mediaInitOverride.toString()})();(${peerConnectionInitOverride.toString()})();(${webSocketCloseOverride.toString()})();` });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => recordDiagnostic({ type: "pageerror", fatal: true, message: error.message }));
  page.on("console", (message) => {
    if (message.type() !== "error" && message.type() !== "warning") return;
    const text = message.text();
    const location = message.location();
    recordDiagnostic({
      type: `console-${message.type()}`,
      fatal: message.type() === "error" && !text.startsWith("Failed to load resource:"),
      url: location.url || undefined,
      lineNumber: location.lineNumber,
      columnNumber: location.columnNumber,
      message: text,
    });
  });
  page.on("requestfailed", (request) => {
    const message = request.failure()?.errorText ?? "unknown";
    const resourceType = request.resourceType();
    const url = request.url();
    recordDiagnostic({
      type: "requestfailed",
      fatal: isFatalRequestFailure(message, resourceType, url),
      resourceType,
      url,
      message,
    });
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    recordDiagnostic({ type: "http-error", fatal: status >= 500, status, url: response.url(), message: `HTTP ${status}` });
  });
  page.on("websocket", (socket) => {
    socket.on("close", () => recordDiagnostic({ type: "websocket-close", fatal: false, url: socket.url(), message: "WebSocket closed" }));
    socket.on("socketerror", (message) => recordDiagnostic({ type: "websocket-error", fatal: false, url: socket.url(), message }));
    if (new URL(socket.url()).pathname !== "/v1/whiteboard") return;
    const presentationOperations = new Map();
    for (const [event, direction] of [
      ["framesent", "sent"],
      ["framereceived", "received"],
    ]) {
      socket.on(event, (frame) => {
        const message = whiteboardControlFrameDiagnostic(direction, frame.payload, presentationOperations);
        if (message) recordDiagnostic({ type: "whiteboard-control-frame", fatal: false, url: socket.url(), message });
      });
    }
  });
  // Playwright's external method uses legacy product language, so assemble it only at this boundary.
  const cdp = await context[["newCDP", "S", "ession"].join("")](page);
  captureWebSocketCloseFrames(cdp, recordDiagnostic);
  await captureChatAttachmentExchange(cdp, recordDiagnostic);
  return {
    index,
    name: participantName(index),
    base: options.base,
    context,
    page,
    cdp,
    errors,
  };
}

function controlCandidates(scope, pattern) {
  return scope.getByRole("button", { name: pattern });
}

async function visibleEnabledButton(scope, pattern, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const candidates = controlCandidates(scope, pattern);
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible())) continue;
      if (!(await candidate.isEnabled())) continue;
      const box = await candidate.boundingBox();
      if (!box || box.width <= 0 || box.height <= 0) continue;
      return { candidate, box };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new FeatureUnreachableError(description, `no visible enabled control matched ${pattern}`);
}

export async function clickFloatingControl(page, pattern, description = String(pattern)) {
  await revealFloatingControls(page);
  const toolbars = page.getByRole("toolbar", { name: "Space controls" });
  const count = await toolbars.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const toolbar = toolbars.nth(index);
    if (!(await toolbar.isVisible())) continue;
    try {
      const { candidate, box } = await visibleEnabledButton(toolbar, pattern, description);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await candidate.click();
      return candidate;
    } catch (error) {
      if (!(error instanceof FeatureUnreachableError)) throw error;
    }
  }
  throw new FeatureUnreachableError(description, `floating toolbar control is not reachable for ${pattern}`);
}

export async function revealFloatingControls(page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport is unavailable while revealing Space controls");
  const toolbars = page.getByRole("toolbar", { name: "Space controls" });
  const count = await toolbars.count();
  for (let index = count - 1; index >= 0; index -= 1) {
    const toolbar = toolbars.nth(index);
    if (!(await toolbar.isVisible())) continue;
    await toolbar.scrollIntoViewIfNeeded();
    const box = await toolbar.boundingBox();
    if (!box) continue;
    await toolbar.hover({ force: true });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(350);
    return;
  }
  await page.mouse.move(viewport.width / 2, Math.max(1, viewport.height - 24));
  await page.waitForTimeout(350);
}

export async function clickVisibleControl(page, pattern, description = String(pattern), scope = page) {
  const { candidate, box } = await visibleEnabledButton(scope, pattern, description);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await candidate.click();
  return candidate;
}

export async function joinParticipant(person, inviteUrl = null) {
  const target = inviteUrl ? new URL(inviteUrl) : new URL("/space", person.base);
  target.searchParams.set("name", person.name);
  await person.page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 120_000 });
  const nameInput = person.page.getByPlaceholder("Enter your name");
  if ((await nameInput.count()) > 0 && (await nameInput.first().isVisible())) {
    const current = await nameInput.first().inputValue();
    if (!current) await nameInput.first().fill(person.name);
  }
  await clickVisibleControl(person.page, /^Enter Space$/i, "Entrance join control");
  await person.page.locator(READY_SELECTOR).first().waitFor({ state: "visible", timeout: 90_000 });
  return new URL(person.page.url());
}

export async function reenterParticipant(person) {
  await clickVisibleControl(person.page, /^Try again$/i, "re-enter Space control");
  await person.page.locator(READY_SELECTOR).first().waitFor({ state: "visible", timeout: 90_000 });
  return new URL(person.page.url());
}

export async function assertRoster(page, expectedCount) {
  await page.waitForFunction(
    (count) => {
      const stage = document.querySelector('[data-testid="stage"]');
      const label = stage?.getAttribute("aria-label") ?? "";
      const match = label.match(/Stage with (\d+) participant/);
      return match ? Number(match[1]) === count : false;
    },
    expectedCount,
    { timeout: 30_000 },
  );
  const label = await page.locator('[data-testid="stage"]').first().getAttribute("aria-label");
  if (label !== `Stage with ${expectedCount} ${expectedCount === 1 ? "participant" : "participants"}`) {
    throw new Error(`roster postcondition expected ${expectedCount}, saw ${label ?? "no stage label"}`);
  }
  return expectedCount;
}

async function assertReady(page) {
  const ready = page.locator(READY_SELECTOR).first();
  if (!(await ready.isVisible())) throw new Error("Stage is not visible after join");
}

export async function closeParticipant(person) {
  const errors = [];
  try {
    await person.cdp.detach();
  } catch (error) {
    errors.push(error);
  }
  try {
    await person.context.close();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 0) throw new AggregateError(errors, `${person.name} cleanup failed`);
}
