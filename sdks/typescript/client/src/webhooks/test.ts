import { webhookFixturesV1 } from "./generated/fixtures-v1.js";
import type { WebhookInbox } from "./types.js";

const encoder = new TextEncoder();

const decodeSecret = (secret: string): Uint8Array => {
  if (!secret.startsWith("whsec_")) throw new Error("Test signer received an invalid secret.");
  const binary = atob(secret.slice(6));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const encodeBase64 = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
};

export const getTestOnlyWebhookFixture = (eventName: string) => {
  const fixture = webhookFixturesV1.find((entry) => entry.event === eventName);
  if (!fixture) throw new Error("The requested webhook fixture does not exist.");
  return Object.freeze({ event: fixture.event, rawBody: encoder.encode(fixture.body_utf8) });
};

export const signTestOnlyWebhook = async (input: { rawBody: Uint8Array; webhookId: string; timestamp: number; secrets: readonly string[] }): Promise<Headers> => {
  const prefix = encoder.encode(`${input.webhookId}.${input.timestamp}.`);
  const payload = new Uint8Array(prefix.length + input.rawBody.length);
  payload.set(prefix);
  payload.set(input.rawBody, prefix.length);
  const signatures: string[] = [];
  for (const secret of input.secrets) {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(decodeSecret(secret)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    signatures.push(`v1,${encodeBase64(new Uint8Array(await crypto.subtle.sign("HMAC", key, new Uint8Array(payload))))}`);
  }
  return new Headers({
    "webhook-id": input.webhookId,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": signatures.join(" "),
  });
};

type InboxEntry = { state: "leased"; token: string; expiresAt: number } | { state: "completed"; completedAt: number };

const isRetainedCompletion = (entry: InboxEntry | undefined, now: number, retentionMilliseconds: number): boolean => entry?.state === "completed" && entry.completedAt + retentionMilliseconds > now;

const isActiveLease = (entry: InboxEntry | undefined, now: number): entry is Extract<InboxEntry, { state: "leased" }> => entry?.state === "leased" && entry.expiresAt > now;

export class TestOnlyInMemoryWebhookInbox implements WebhookInbox {
  readonly #entries = new Map<string, InboxEntry>();
  readonly #now: () => number;
  readonly #retentionMilliseconds: number;
  #nextToken = 1;

  constructor(options: { now?: () => number; retentionMilliseconds?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#retentionMilliseconds = options.retentionMilliseconds ?? 30 * 24 * 60 * 60 * 1_000;
  }

  async acquire(input: { eventId: string; leaseMilliseconds: number }) {
    const now = this.#now();
    const current = this.#entries.get(input.eventId);
    if (isRetainedCompletion(current, now, this.#retentionMilliseconds)) {
      return { state: "completed" } as const;
    }
    if (isActiveLease(current, now)) {
      return { state: "busy", retryAfterSeconds: Math.max(1, Math.ceil((current.expiresAt - now) / 1_000)) } as const;
    }
    const token = `test-lease-${this.#nextToken}`;
    this.#nextToken += 1;
    this.#entries.set(input.eventId, { state: "leased", token, expiresAt: now + input.leaseMilliseconds });
    return { state: "acquired", token } as const;
  }

  async complete(input: { eventId: string; token: string }) {
    const current = this.#entries.get(input.eventId);
    if (current?.state !== "leased" || current.token !== input.token) throw new Error("The test inbox lease is not owned.");
    this.#entries.set(input.eventId, { state: "completed", completedAt: this.#now() });
  }

  async release(input: { eventId: string; token: string }) {
    const current = this.#entries.get(input.eventId);
    if (current?.state === "leased" && current.token === input.token) this.#entries.delete(input.eventId);
  }
}
