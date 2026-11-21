import type { ScreenAnnotationHelper, ScreenAnnotationHelperShare, ScreenAnnotationHelperStatus } from "@q9labsai/chalk-react";
import { z } from "zod";

const loopback = "http://127.0.0.1:47361";
const attachLifetimeMs = 60_000;
const networkTimeoutMs = 10_000;
const statusSchema = z.enum(["unbound", "calibrating", "ready", "unsupported_surface", "update_required", "disconnected"]);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const deadline = z.number().int().positive();
const challengeSchema = z.strictObject({ version: z.number().int().positive().max(255), helperPublicKey: secret, challenge: secret, expiresAtMs: deadline });
const attachSchema = z.strictObject({ sessionSecret: secret, leaseExpiresAtMs: deadline, status: statusSchema });
const statusEvent = z.strictObject({ type: z.literal("status"), status: statusSchema });
const ticketFormat = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

type Challenge = z.infer<typeof challengeSchema>;
type HelperListener = (status: ScreenAnnotationHelperStatus) => void;
type HelperPath = "/v1/challenge" | "/v1/attach" | "/v1/events" | "/v1/exchange";

export interface HelperPairAuthority {
  readonly issueLocalTicket: (input: { challenge: Challenge; origin: string; share: ScreenAnnotationHelperShare; signal: AbortSignal }) => Promise<string>;
  readonly lookupCode?: ScreenAnnotationHelper["lookupCode"];
}

export function createBrowserAnnotationHelper({ origin, installUrl, authority }: { readonly origin: string; readonly installUrl?: string; readonly authority: HelperPairAuthority }): ScreenAnnotationHelper {
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
            const ticket = await authority.issueLocalTicket({ challenge, origin, share, signal: attachSignal });
            if (ticket.length > 4096 || !ticketFormat.test(ticket) || !activeShare(share)) throw new Error("The Helper ticket could not be issued.");
            // The Helper displays the same fingerprint and holds this response for its own native approval.
            const attachment = await localRequest("/v1/attach", attachSignal, { version: 1, challenge: challenge.challenge, pairTicket: ticket }).then((response) => readJson(response, attachSchema));
            try {
              const lease = AbortSignal.any([session, AbortSignal.timeout(remaining(attachment.leaseExpiresAtMs))]);
              if (!activeShare(share) || lease.aborted) throw new Error("The Helper attachment is no longer valid.");
              onStatus(attachment.status);
              await watchStatuses(attachment.sessionSecret, lease, onStatus);
            } finally {
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

export function activeShare(share: ScreenAnnotationHelperShare): boolean {
  const snapshot = share.client.getSnapshot();
  const live = snapshot.status === "ready" ? snapshot.state?.layer : null;
  return Boolean(live && live.layer_id === share.layer.layer_id && live.publication_id === share.layer.publication_id && live.sharer_id === share.participantId);
}

// The address, paths and methods are closed. No response or configuration supplies a local URL.
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

async function watchStatuses(attachmentSecret: string, signal: AbortSignal, onStatus: HelperListener): Promise<void> {
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
          if (line.length > 8192) throw new Error("Helper event is too large.");
          buffered = buffered.slice(boundary + 1);
          if (line.startsWith("data: ")) {
            const payload: unknown = JSON.parse(line.slice(6));
            const event = statusEvent.parse(payload);
            onStatus(event.status);
            renewHeartbeat();
          }
          boundary = buffered.indexOf("\n");
        }
        if (buffered.length > 8192) throw new Error("Helper event is too large.");
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
  onStatus("disconnected");
}
