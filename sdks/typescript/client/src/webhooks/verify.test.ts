import { describe, expect, it } from "vitest";
import vectors from "../../../../../contract/webhooks/v1/signature-vectors.json";
import fixtures from "../../../../../contract/webhooks/v1/fixtures.json";
import { WebhookVerificationError } from "./errors";
import { getTestOnlyWebhookFixture, signTestOnlyWebhook } from "./test";
import { verifyWebhook } from "./verify";

const encoder = new TextEncoder();
const now = () => new Date(Number(vectors.webhook_timestamp) * 1_000);
const headers = (signature = vectors.overlap_header, id = vectors.webhook_id) =>
  new Headers({
    "webhook-id": id,
    "webhook-timestamp": vectors.webhook_timestamp,
    "webhook-signature": signature,
  });

const expectCode = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toMatchObject<WebhookVerificationError>({ code });
};

describe("verifyWebhook", () => {
  it("validates every Event fixture mechanically derived from the version 1 contract", async () => {
    const secret = vectors.secrets[0]!.value;
    for (const fixture of fixtures.fixtures) {
      const rawBody = encoder.encode(fixture.body_utf8);
      const body = JSON.parse(fixture.body_utf8) as { id: string };
      const fixtureHeaders = await signTestOnlyWebhook({
        rawBody,
        webhookId: body.id,
        timestamp: Number(vectors.webhook_timestamp),
        secrets: [secret],
      });
      const event = await verifyWebhook({ rawBody, headers: fixtureHeaders, secrets: [secret], now });
      expect(event.event).toBe(fixture.event);
    }
  });

  it("verifies the official Unicode fixture with either rotation secret", async () => {
    for (const secret of vectors.secrets) {
      const event = await verifyWebhook({
        rawBody: encoder.encode(vectors.body_utf8),
        headers: headers(secret.signature),
        secrets: [secret.value],
        now,
      });
      expect(event.event).toBe("participant.joined");
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.data)).toBe(true);
    }
  });

  it("accepts rotation overlap and case-insensitive record headers", async () => {
    const event = await verifyWebhook({
      rawBody: encoder.encode(vectors.body_utf8),
      headers: {
        "Webhook-Id": vectors.webhook_id,
        "WEBHOOK-TIMESTAMP": vectors.webhook_timestamp,
        "webhook-signature": vectors.overlap_header,
      },
      secrets: vectors.secrets.map((secret) => secret.value),
      now,
    });
    expect(event.id).toBe(vectors.webhook_id);

    const arraySignatures = await verifyWebhook({
      rawBody: encoder.encode(vectors.body_utf8),
      headers: {
        "webhook-id": vectors.webhook_id,
        "webhook-timestamp": vectors.webhook_timestamp,
        "webhook-signature": vectors.secrets.map((secret) => secret.signature),
      },
      secrets: vectors.secrets.map((secret) => secret.value),
      now,
    });
    expect(arraySignatures.id).toBe(vectors.webhook_id);
  });

  it("rejects duplicate case-insensitive headers and arrays outside signatures", async () => {
    const rawBody = encoder.encode(vectors.body_utf8);
    const base = {
      "webhook-id": vectors.webhook_id,
      "webhook-timestamp": vectors.webhook_timestamp,
      "webhook-signature": vectors.secrets[0]!.signature,
    };
    await expectCode(verifyWebhook({ rawBody, headers: { ...base, "Webhook-Id": vectors.webhook_id }, secrets: [vectors.secrets[0]!.value], now }), "malformed_headers");
    await expectCode(verifyWebhook({ rawBody, headers: { ...base, "Webhook-Signature": vectors.secrets[0]!.signature }, secrets: [vectors.secrets[0]!.value], now }), "malformed_headers");
    await expectCode(verifyWebhook({ rawBody, headers: { ...base, "webhook-timestamp": [vectors.webhook_timestamp] }, secrets: [vectors.secrets[0]!.value], now }), "malformed_headers");
  });

  it("rejects bodies over 256 KiB before signature work", async () => {
    await expectCode(verifyWebhook({ rawBody: new Uint8Array(256 * 1_024 + 1), headers: new Headers(), secrets: [] }), "invalid_event_body");
  });

  it("rejects invalid clocks and unsafe tolerance values", async () => {
    const input = {
      rawBody: encoder.encode(vectors.body_utf8),
      headers: headers(),
      secrets: [vectors.secrets[0]!.value],
    };
    for (const toleranceSeconds of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expectCode(verifyWebhook({ ...input, toleranceSeconds, now }), "malformed_headers");
    }
    await expectCode(verifyWebhook({ ...input, now: () => new Date(Number.NaN) }), "stale_timestamp");
    await expectCode(verifyWebhook({ ...input, now: (() => "invalid") as unknown as () => Date }), "stale_timestamp");
  });

  it("keeps the default tolerance at five minutes", async () => {
    const timestamp = Number(vectors.webhook_timestamp);
    const input = {
      rawBody: encoder.encode(vectors.body_utf8),
      headers: headers(),
      secrets: [vectors.secrets[0]!.value],
    };
    await expect(verifyWebhook({ ...input, now: () => new Date((timestamp + 300) * 1_000) })).resolves.toMatchObject({ id: vectors.webhook_id });
    await expectCode(verifyWebhook({ ...input, now: () => new Date((timestamp + 301) * 1_000) }), "stale_timestamp");
  });

  it("authenticates before parsing or validating content", async () => {
    const mutated = encoder.encode(`${vectors.body_utf8} `);
    await expectCode(verifyWebhook({ rawBody: mutated, headers: headers(), secrets: [vectors.secrets[0]!.value], now }), "invalid_signature");
    await expectCode(verifyWebhook({ rawBody: encoder.encode("{"), headers: headers(), secrets: [vectors.secrets[0]!.value], now }), "invalid_signature");

    const invalidJson = encoder.encode("{");
    const signed = await signTestOnlyWebhook({
      rawBody: invalidJson,
      webhookId: vectors.webhook_id,
      timestamp: Number(vectors.webhook_timestamp),
      secrets: [vectors.secrets[0]!.value],
    });
    await expectCode(verifyWebhook({ rawBody: invalidJson, headers: signed, secrets: [vectors.secrets[0]!.value], now }), "invalid_json");
  });

  it("returns stable failures without payload or secret content", async () => {
    const cases: Array<[() => Promise<unknown>, string]> = [
      [() => verifyWebhook({ rawBody: encoder.encode(vectors.body_utf8), headers: new Headers(), secrets: [vectors.secrets[0]!.value], now }), "missing_headers"],
      [() => verifyWebhook({ rawBody: encoder.encode(vectors.body_utf8), headers: headers("bad"), secrets: [vectors.secrets[0]!.value], now }), "malformed_headers"],
      [() => verifyWebhook({ rawBody: encoder.encode(vectors.body_utf8), headers: headers(), secrets: ["whsec_bad"], now }), "invalid_secret"],
      [() => verifyWebhook({ rawBody: encoder.encode(vectors.body_utf8), headers: headers(), secrets: [vectors.secrets[0]!.value], now: () => new Date(0) }), "stale_timestamp"],
      [() => verifyWebhook({ rawBody: encoder.encode(vectors.body_utf8), headers: headers(vectors.secrets[1]!.signature), secrets: [vectors.secrets[0]!.value], now }), "invalid_signature"],
      [() => verifyWebhook({ rawBody: encoder.encode(vectors.body_utf8), headers: headers(undefined, "00000000-0000-4000-8000-000000000099"), secrets: [vectors.secrets[0]!.value], now }), "invalid_signature"],
    ];
    for (const [verify, code] of cases) {
      try {
        await verify();
        expect.fail("verification unexpectedly passed");
      } catch (error) {
        expect(error).toMatchObject({ code });
        const message = String(error);
        expect(message).not.toContain("Ada");
        expect(message).not.toContain("whsec_");
        expect(message).not.toContain("東京");
      }
    }
  });

  it("normalizes malformed runtime secret collections", async () => {
    const input = { rawBody: encoder.encode(vectors.body_utf8), headers: headers(), now };
    const malformedSecrets: unknown[] = [null, vectors.secrets[0]!.value, { 0: vectors.secrets[0]!.value, length: 1 }, [vectors.secrets[0]!.value, null], [vectors.secrets[0]!.value, 7]];
    for (const secrets of malformedSecrets) {
      await expectCode(verifyWebhook({ ...input, secrets: secrets as readonly string[] }), "invalid_secret");
    }
  });

  it("rejects calendar-invalid envelope and nested timestamps", async () => {
    const secret = vectors.secrets[0]!.value;
    const verifyBody = async (body: Record<string, unknown>) => {
      const rawBody = encoder.encode(JSON.stringify(body));
      const signed = await signTestOnlyWebhook({
        rawBody,
        webhookId: String(body.id),
        timestamp: Number(vectors.webhook_timestamp),
        secrets: [secret],
      });
      return verifyWebhook({ rawBody, headers: signed, secrets: [secret], now });
    };
    const event = JSON.parse(vectors.body_utf8) as Record<string, unknown>;
    await expectCode(verifyBody({ ...event, occurred_at: "2026-99-99T99:99:99.999Z" }), "invalid_event_body");

    const data = event.data as { object: Record<string, unknown> };
    await expectCode(verifyBody({ ...event, data: { ...data, object: { ...data.object, joined_at: "2026-02-29T18:05:00.000Z" } } }), "invalid_event_body");
    await expectCode(verifyBody({ ...event, event: "participant.future", occurred_at: "2026-04-31T18:05:00.000Z" }), "invalid_event_body");
  });

  it("rejects a signed identifier mismatch, unsupported version, and invalid known body", async () => {
    const secret = vectors.secrets[0]!.value;
    const signBody = async (body: Record<string, unknown>, id = vectors.webhook_id) => {
      const rawBody = encoder.encode(JSON.stringify(body));
      const signed = await signTestOnlyWebhook({ rawBody, webhookId: id, timestamp: Number(vectors.webhook_timestamp), secrets: [secret] });
      return { rawBody, headers: signed, secrets: [secret], now };
    };
    const parsed = JSON.parse(vectors.body_utf8) as Record<string, unknown>;
    await expectCode(verifyWebhook(await signBody({ ...parsed, id: "00000000-0000-4000-8000-000000000099" })), "identifier_mismatch");
    await expectCode(verifyWebhook(await signBody({ ...parsed, api_version: 2 })), "unsupported_api_version");
    await expectCode(verifyWebhook(await signBody({ ...parsed, data: { object: { status: "active" } } })), "invalid_event_body");
  });

  it("acknowledges an authenticated unknown Event after envelope validation", async () => {
    const fixture = getTestOnlyWebhookFixture("endpoint.test");
    const body = JSON.parse(new TextDecoder().decode(fixture.rawBody)) as Record<string, unknown>;
    body.event = "room.future_state";
    const rawBody = encoder.encode(JSON.stringify(body));
    const secret = vectors.secrets[0]!.value;
    const signed = await signTestOnlyWebhook({ rawBody, webhookId: String(body.id), timestamp: Number(vectors.webhook_timestamp), secrets: [secret] });
    const event = await verifyWebhook({ rawBody, headers: signed, secrets: [secret], now });
    expect(event.event).toBe("room.future_state");
  });
});
