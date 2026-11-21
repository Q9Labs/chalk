import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "@q9labsai/chalk-react";
import { z } from "zod";
import { helperDeviceOffer, manageHelperDevice } from "./dashboard/helper-devices";
import { calibrateMonitor, calibrateWindow, chromiumWindowId, probeSchema } from "./screen-annotation-helper-calibration";

const loopback = "http://127.0.0.1:47361";
const attachLifetimeMs = 60_000;
const networkTimeoutMs = 10_000;
const statusSchema = z.enum(["unbound", "calibrating", "ready", "unsupported_surface", "update_required", "disconnected"]);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deadline = z.number().int().positive();
const challengeSchema = z.strictObject({ version: z.number().int().positive().max(255), helperPublicKey: secret, challenge: secret, expiresAtMs: deadline });
const attachSchema = z.strictObject({ sessionSecret: secret, leaseExpiresAtMs: deadline, status: statusSchema });
const statusEvent = z.strictObject({ type: z.literal("status"), status: statusSchema });
const frameCoordinate = z.number().int().min(0).max(65535);
const penEvent = z.strictObject({
  type: z.literal("pen"),
  pen: z.strictObject({
    fence: deadline,
    width: z.number().int().min(32).max(3277),
    points: z
      .array(z.strictObject({ x: frameCoordinate, y: frameCoordinate }))
      .min(1)
      .max(384),
  }),
});
const helperEvent = z.discriminatedUnion("type", [statusEvent, penEvent]);
type HelperPen = z.infer<typeof penEvent>["pen"];
const ticket = z.strictObject({
  ticket: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  expiresAtMs: deadline,
});
const ticketsSchema = z.strictObject({ pair: ticket, attachment: ticket });

type Challenge = z.infer<typeof challengeSchema>;
type Tickets = z.infer<typeof ticketsSchema>;
type HelperPath = "/v1/challenge" | "/v1/attach" | "/v1/events" | "/v1/exchange";

export interface HelperPairAuthority {
  readonly issueLocalTicket: (input: { challenge: Challenge; origin: string; share: ScreenAnnotationHelperShare; signal: AbortSignal }) => Promise<Tickets>;
  readonly lookupCode?: ScreenAnnotationHelper["lookupCode"];
}

type CaptureTrack = (share: ScreenAnnotationHelperShare) => MediaStreamTrack | undefined;

export function createBrowserAnnotationHelper({ origin, installUrl, authority, captureTrack }: { readonly origin: string; readonly installUrl?: string; readonly authority: HelperPairAuthority; readonly captureTrack?: CaptureTrack }): ScreenAnnotationHelper {
  return {
    installUrl,
    lookupCode: authority.lookupCode,
    async challenge(share, parent) {
      if (!window.isSecureContext || window.location.origin !== origin || !origin.startsWith("https://") || !activeShare(share)) throw new Error("Helper is not available for this share.");
      const challenge = await localRequest("/v1/challenge", AbortSignal.any([parent, AbortSignal.timeout(networkTimeoutMs)]), {}).then((response) => readJson(response, challengeSchema));
      if (challenge.version !== 1) return { kind: "update_required" };
      const challengeMs = remaining(challenge.expiresAtMs);
      const signal = AbortSignal.any([parent, AbortSignal.timeout(challengeMs)]);
      const fingerprint = await challengeFingerprint(challenge);
      let started = false;
      return {
        kind: "approval",
        fingerprint,
        async attach(onStatus) {
          if (started || signal.aborted || !activeShare(share)) throw new Error("The Helper challenge is no longer valid.");
          started = true;
          const stop = new AbortController();
          const unsubscribe = share.client.subscribe(() => {
            if (!activeShare(share)) stop.abort();
          });
          const session = AbortSignal.any([stop.signal, parent]);
          try {
            const attachSignal = AbortSignal.any([signal, session]);
            const tickets = await authority.issueLocalTicket({ challenge, origin, share, signal: attachSignal });
            if (!activeShare(share)) throw new Error("The screen share changed.");
            const attachment = await localRequest("/v1/attach", attachSignal, {
              version: 1,
              challenge: challenge.challenge,
              pairTicket: tickets.pair.ticket,
              attachmentTicket: tickets.attachment.ticket,
            }).then((response) => readJson(response, attachSchema));
            const renewal = new AbortController();
            const track = captureTrack?.(share);
            try {
              if (!activeShare(share) || session.aborted) throw new Error("The Helper attachment is no longer valid.");
              onStatus(attachment.status);
              const live = AbortSignal.any([session, renewal.signal]);
              const project = liveProjection({ track, share, currentTrack: () => captureTrack?.(share), attachmentSecret: attachment.sessionSecret, signal: live });
              await project.describe();
              await Promise.race([
                project.failure,
                watchEvents(attachment.sessionSecret, live, async (event) => {
                  if (event.type === "pen") {
                    await project.commit(event.pen);
                  } else {
                    onStatus(event.status);
                    await project.observe(event.status);
                  }
                }),
                renewLease({
                  attachmentSecret: attachment.sessionSecret,
                  expiresAtMs: Math.min(attachment.leaseExpiresAtMs, tickets.attachment.expiresAtMs),
                  signal: live,
                  issue: (signal) => authority.issueLocalTicket({ challenge, origin, share, signal }),
                }),
              ]);
            } finally {
              renewal.abort();
              // A tab closing may prevent the delivery; the Helper's lease is the authority.
              void localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "disconnect" }, attachment.sessionSecret).catch(() => undefined);
            }
          } finally {
            unsubscribe();
          }
        },
      };
    },
  };
}

export function createManagedAnnotationHelper(options: { readonly origin: string; readonly apiBaseUrl: string; readonly mediaProof: () => string | null | undefined; readonly installUrl?: string; readonly captureTrack?: CaptureTrack; readonly signedIn?: boolean }): ScreenAnnotationHelper {
  const api = new URL("/v1/screen-annotation/helper/pair-ticket", options.apiBaseUrl);
  if (api.protocol !== "https:" || api.username || api.password) throw new Error("Invalid Helper API.");
  return createBrowserAnnotationHelper({
    origin: options.origin,
    installUrl: options.installUrl,
    captureTrack: options.captureTrack,
    authority: {
      lookupCode: options.signedIn
        ? async (code, share, signal) => {
            if (!activeShare(share)) throw new Error("The screen share is no longer authorized.");
            const offer = await manageHelperDevice({ action: "lookup", code }, signal).then((response) => readJson(response, helperDeviceOffer));
            return {
              deviceName: offer.name,
              fingerprint: offer.fingerprint,
              async approve(onStatus) {
                const approve = async (refresh: boolean) => {
                  const mediaProof = options.mediaProof();
                  if (!mediaProof || !activeShare(share)) throw new Error("The screen share is no longer authorized.");
                  await manageHelperDevice(
                    {
                      action: "approve",
                      requestId: offer.requestId,
                      mediaProof,
                      refresh,
                      layerId: share.layer.layer_id,
                      publicationId: share.layer.publication_id,
                    },
                    AbortSignal.any([signal, AbortSignal.timeout(networkTimeoutMs)]),
                  );
                };
                await approve(false);
                onStatus("device_approved");
                while (!signal.aborted) {
                  await delay(10_000, signal);
                  if (!signal.aborted) await approve(true);
                }
              },
            };
          }
        : undefined,
      async issueLocalTicket({ challenge, share, signal }) {
        const proof = options.mediaProof();
        if (!proof || !activeShare(share)) throw new Error("The screen share is no longer authorized.");
        const response = await fetch(api, {
          method: "POST",
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${proof}` },
          body: JSON.stringify({
            version: challenge.version,
            challenge: challenge.challenge,
            helperPublicKey: challenge.helperPublicKey,
            layerId: share.layer.layer_id,
            publicationId: share.layer.publication_id,
          }),
          signal,
        });
        if (!response.ok) throw new Error("The Helper ticket could not be issued.");
        return readJson(response, ticketsSchema);
      },
    },
  });
}

function liveProjection({
  track,
  share,
  currentTrack,
  attachmentSecret,
  signal,
}: {
  readonly track: MediaStreamTrack | undefined;
  readonly share: ScreenAnnotationHelperShare;
  readonly currentTrack: () => MediaStreamTrack | undefined;
  readonly attachmentSecret: string;
  readonly signal: AbortSignal;
}) {
  const settings = track?.getSettings();
  const chromium = /(?:Chrome|Chromium)\//.test(navigator.userAgent);
  const monitor = chromium && share.surface === "monitor" && settings?.displaySurface === "monitor" && Boolean(settings.width && settings.height);
  const windowId = chromium && share.surface === "window" && settings?.displaySurface === "window" && track ? chromiumWindowId(track.label) : undefined;
  let verifiedWindowSize: { width: number; height: number } | undefined;
  let calibrated = false;
  let sending = false;
  let observed = false;
  let pushing = false;
  let checkWindowAfter = 0;
  const exchange = (data: object, timeout = 1500) => localRequest("/v1/exchange", AbortSignal.any([signal, AbortSignal.timeout(timeout)]), data, attachmentSecret);
  function checkSource() {
    const current = track?.getSettings();
    if (
      !track ||
      track !== currentTrack() ||
      track.readyState !== "live" ||
      !activeShare(share) ||
      (windowId ? current?.displaySurface !== "window" || chromiumWindowId(track.label) !== windowId : current?.displaySurface !== "monitor" || current.width !== settings?.width || current.height !== settings?.height)
    ) {
      throw new Error("The capture changed.");
    }
  }
  async function publish(): Promise<void> {
    if (!observed) return;
    checkSource();
    if (windowId && verifiedWindowSize) {
      const size = track?.getSettings();
      if (size?.width !== verifiedWindowSize.width || size.height !== verifiedWindowSize.height) {
        observed = false;
        await exchange({ type: "probe_abort" });
        return;
      }
    }
    const snapshot = share.client.getSnapshot();
    if (snapshot.status !== "ready" || !snapshot.state) throw new Error("The screen share is no longer active.");
    const { layer, marks, paused, fence, access } = snapshot.state;
    await exchange({
      type: "scene",
      layerId: layer.layer_id,
      publicationId: layer.publication_id,
      width: verifiedWindowSize?.width ?? settings?.width,
      height: verifiedWindowSize?.height ?? settings?.height,
      scene: { marks, presence: snapshot.presence, paused, fence, canDraw: access.can_draw, sharerId: layer.sharer_id, serverAtMs: Math.round(share.client.serverNowMs()) },
    });
  }
  function pushLatest(onError: (reason: unknown) => void) {
    let dirty = false;
    const flush = async () => {
      dirty = true;
      if (sending) return;
      sending = true;
      try {
        while (dirty && !signal.aborted) {
          dirty = false;
          await publish();
        }
      } catch (error) {
        // A concurrent native move/resize can hide the overlay before the
        // status event reaches the browser. Keep waiting for revalidation.
        if (windowId && error instanceof HelperConflict) {
          observed = false;
        } else if (!signal.aborted) onError(error);
      } finally {
        sending = false;
      }
    };
    const unsubscribe = share.client.subscribe(() => void flush());
    const heartbeat = setInterval(() => void flush(), 1500);
    signal.addEventListener(
      "abort",
      () => {
        clearInterval(heartbeat);
        unsubscribe();
      },
      { once: true },
    );
    void flush();
  }
  const failure = new AbortController();
  const failed = new Promise<void>((_, reject) => {
    failure.signal.addEventListener("abort", () => reject(failure.signal.reason), { once: true });
  });
  return {
    failure: failed,
    async commit(pen: HelperPen) {
      checkSource();
      const snapshot = share.client.getSnapshot();
      if (!observed || snapshot.status !== "ready" || !snapshot.state || snapshot.state.fence !== pen.fence || !snapshot.state.access.can_draw) return;
      await share.client.dispatch(
        { layerId: share.layer.layer_id, fence: pen.fence },
        {
          kind: "commit",
          draft: {
            mark_id: crypto.randomUUID(),
            lifetime: "fade",
            color: "#ffffff",
            width: pen.width,
            shape: { kind: "pen", points: pen.points },
          },
        },
      );
    },
    async describe() {
      await exchange({ type: "capture", surface: monitor ? "monitor" : windowId ? "window" : "unsupported", width: settings?.width ?? 1, height: settings?.height ?? 1, windowId });
    },
    async observe(status: ScreenAnnotationHelperStatus) {
      if (status === "calibrating" && !calibrated && monitor && track) {
        checkSource();
        calibrated = true;
        await calibrateMonitor({
          track,
          signal,
          start: (signal) => localRequest("/v1/exchange", signal, { type: "probe_start" }, attachmentSecret).then((response) => readJson(response, probeSchema)),
          protect: async (nonce, signal) => {
            await localRequest("/v1/exchange", signal, { type: "probe_protect", nonce }, attachmentSecret);
          },
          complete: async (nonce, signal) => {
            checkSource();
            await localRequest("/v1/exchange", signal, { type: "probe_complete", nonce }, attachmentSecret);
          },
          abort: async () => {
            await localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "probe_abort" }, attachmentSecret);
          },
        });
      } else if (status === "calibrating" && windowId && track) {
        observed = false;
        checkSource();
        if (performance.now() < checkWindowAfter) return;
        checkWindowAfter = performance.now() + 2200;
        let matchedSize: { width: number; height: number } | undefined;
        await calibrateWindow({
          track,
          signal,
          verify: async (input, probeSignal) => {
            const response = await localRequest("/v1/exchange", probeSignal, { type: "window_sample", ...input }, attachmentSecret);
            if (response.status !== 200) return false;
            matchedSize = { width: input.width, height: input.height };
            return true;
          },
          start: (probeSignal) => localRequest("/v1/exchange", probeSignal, { type: "window_probe_start" }, attachmentSecret).then((response) => readJson(response, probeSchema)),
          complete: async (nonce, probeSignal) => {
            checkSource();
            await localRequest("/v1/exchange", probeSignal, { type: "probe_complete", nonce }, attachmentSecret);
            verifiedWindowSize = matchedSize;
          },
          abort: async () => {
            await localRequest("/v1/exchange", AbortSignal.timeout(1500), { type: "probe_abort" }, attachmentSecret);
          },
        });
      } else if (status === "ready" && !observed) {
        observed = true;
        if (signal.aborted || pushing) return;
        pushing = true;
        pushLatest((reason) => failure.abort(reason));
      }
    },
  };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

async function renewLease({ attachmentSecret, expiresAtMs, signal, issue }: { readonly attachmentSecret: string; readonly expiresAtMs: number; readonly signal: AbortSignal; readonly issue: (signal: AbortSignal) => Promise<Tickets> }): Promise<void> {
  let expiry = expiresAtMs;
  while (!signal.aborted) {
    const delayMs = Math.max(0, remaining(expiry) - 20_000);
    await delay(delayMs, signal);
    if (signal.aborted) return;
    const refresh = AbortSignal.any([signal, AbortSignal.timeout(Math.min(networkTimeoutMs, remaining(expiry)))]);
    const tickets = await issue(refresh);
    await localRequest(
      "/v1/exchange",
      refresh,
      {
        type: "refresh",
        pairTicket: tickets.pair.ticket,
        attachmentTicket: tickets.attachment.ticket,
      },
      attachmentSecret,
    );
    expiry = Math.min(tickets.pair.expiresAtMs, tickets.attachment.expiresAtMs);
  }
}

export function activeShare(share: ScreenAnnotationHelperShare): boolean {
  const snapshot = share.client.getSnapshot();
  const live = snapshot.status === "ready" ? snapshot.state?.layer : null;
  return Boolean(live && live.layer_id === share.layer.layer_id && live.publication_id === share.layer.publication_id && live.sharer_id === share.participantId);
}

// The address, paths and methods are closed. No response or configuration supplies a local URL.
class HelperConflict extends Error {}

async function localRequest(path: HelperPath, signal: AbortSignal, data?: object, attachmentSecret?: string): Promise<Response> {
  const headers = new Headers();
  if (data) headers.set("Content-Type", "application/json");
  if (attachmentSecret) headers.set("Authorization", `Bearer ${attachmentSecret}`);
  const options: RequestInit & { targetAddressSpace: "loopback" } = {
    method: path === "/v1/events" ? "GET" : "POST",
    mode: "cors",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    targetAddressSpace: "loopback",
    headers,
    signal,
    body: data ? JSON.stringify(data) : undefined,
  };
  const response = await fetch(loopback + path, options);
  if (response.status === 409) throw new HelperConflict("Helper projection is not current.");
  if (!response.ok) throw new Error("Chalk Helper could not be reached.");
  return response;
}

async function challengeFingerprint({ helperPublicKey, challenge }: Challenge): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${helperPublicKey}.${challenge}`));
  const hex = Array.from(new Uint8Array(digest, 0, 4), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

function remaining(expiresAt: number): number {
  const duration = expiresAt - Date.now();
  if (duration <= 0 || duration > attachLifetimeMs) throw new Error("The Helper request expired.");
  return duration;
}

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("application/json") || !response.body) throw new Error("Unexpected Helper response.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let body = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) throw new Error("Helper response is too large.");
      body += decoder.decode(chunk.value, { stream: true });
    }
    const parsed: unknown = JSON.parse(body + decoder.decode());
    return schema.parse(parsed);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function watchEvents(attachmentSecret: string, signal: AbortSignal, observe: (event: z.infer<typeof helperEvent>) => void | Promise<void>): Promise<void> {
  const missedHeartbeat = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const renewHeartbeat = () => {
    clearTimeout(timer);
    timer = setTimeout(() => missedHeartbeat.abort(), networkTimeoutMs);
  };
  renewHeartbeat();
  try {
    const response = await localRequest("/v1/events", AbortSignal.any([signal, missedHeartbeat.signal]), undefined, attachmentSecret);
    if (!response.headers.get("Content-Type")?.toLowerCase().startsWith("text/event-stream") || !response.body) throw new Error("Unexpected Helper stream.");
    const reader = response.body.pipeThrough(new TextDecoderStream("utf-8", { fatal: true })).getReader();
    let buffered = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (signal.aborted) break;
        buffered += chunk.value;
        let boundary = buffered.indexOf("\n");
        while (boundary >= 0) {
          const line = buffered.slice(0, boundary).trimEnd();
          if (line.length > 16384) throw new Error("Helper event is too large.");
          buffered = buffered.slice(boundary + 1);
          if (line.startsWith("data: ")) {
            const payload: unknown = JSON.parse(line.slice(6));
            const event = helperEvent.parse(payload);
            await observe(event);
            if (event.type === "status" && (event.status === "disconnected" || event.status === "update_required")) return;
            renewHeartbeat();
          }
          boundary = buffered.indexOf("\n");
        }
        if (buffered.length > 16384) throw new Error("Helper event is too large.");
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } catch (error) {
    if (!signal.aborted && !missedHeartbeat.signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
  }
  await observe({ type: "status", status: "disconnected" });
}
