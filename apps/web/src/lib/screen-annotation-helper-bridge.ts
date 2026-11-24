import { z } from "zod";

const loopback = "http://127.0.0.1:47361";
const attachLifetimeMs = 60_000;
export const networkTimeoutMs = 10_000;
const statusSchema = z.enum(["waiting_for_sync", "unbound", "calibrating", "ready", "unsupported_surface", "update_required", "disconnected"]);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
const deadline = z.number().int().positive();
export const challengeSchema = z.strictObject({ version: z.number().int().positive().max(255), helperPublicKey: secret, challenge: secret, expiresAtMs: deadline, keyProof: signature.optional() });
export const attachSchema = z.strictObject({ sessionSecret: secret, leaseExpiresAtMs: deadline, confirmation: signature });
const statusEvent = z.strictObject({ type: z.literal("status"), status: statusSchema, sequence: deadline, signature });
const helperEvent = statusEvent;
const ticket = z.strictObject({
  ticket: z
    .string()
    .max(4096)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
  expiresAtMs: deadline,
});
export const ticketsSchema = z.strictObject({ pair: ticket, attachment: ticket, remembered: z.boolean().optional() });

export type Challenge = z.infer<typeof challengeSchema>;
export type Tickets = z.infer<typeof ticketsSchema>;
type HelperPath = "/v1/challenge" | "/v1/cancel" | "/v1/attach" | "/v1/events" | "/v1/exchange";

export function delay(ms: number, signal: AbortSignal): Promise<void> {
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

export async function renewLease({ attachmentSecret, expiresAtMs, signal, issue }: { readonly attachmentSecret: string; readonly expiresAtMs: number; readonly signal: AbortSignal; readonly issue: (signal: AbortSignal) => Promise<Tickets> }): Promise<void> {
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

export class HelperConflict extends Error {}

// The address, paths and methods are closed. No response or configuration supplies a local URL.
export async function localRequest(path: HelperPath, signal: AbortSignal, data?: object, attachmentSecret?: string): Promise<Response> {
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

export function remaining(expiresAt: number): number {
  const duration = expiresAt - Date.now();
  if (duration <= 0 || duration > attachLifetimeMs) throw new Error("The Helper request expired.");
  return duration;
}

export async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
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

export async function watchEvents(attachmentSecret: string, signal: AbortSignal, observe: (event: z.infer<typeof helperEvent>) => void | Promise<void>): Promise<void> {
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
}
