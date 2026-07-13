import { describe, expect, it } from "vitest";
import vectors from "../../../../../contract/webhooks/v1/signature-vectors.json";
import { createWebhookProcessor, toWebhookResponse, type WebhookProcessor } from "./processor";
import { getTestOnlyWebhookFixture, signTestOnlyWebhook, TestOnlyInMemoryWebhookInbox } from "./test";

const processor = createWebhookProcessor({
  secrets: [vectors.secrets[0]!.value],
  inbox: new TestOnlyInMemoryWebhookInbox(),
  handlers: {
    "endpoint.test": () => undefined,
    "participant.left": () => undefined,
    "room.created": () => undefined,
    "session.started": () => undefined,
  },
  toleranceSeconds: Number.MAX_SAFE_INTEGER,
});

const signedFixture = async (eventName: string) => {
  const fixture = getTestOnlyWebhookFixture(eventName);
  const event = JSON.parse(new TextDecoder().decode(fixture.rawBody)) as { id: string };
  const headers = await signTestOnlyWebhook({
    rawBody: fixture.rawBody,
    webhookId: event.id,
    timestamp: Number(vectors.webhook_timestamp),
    secrets: [vectors.secrets[0]!.value],
  });
  return { ...fixture, headers };
};

const webRequestRecipe = async (request: Request, target: WebhookProcessor) => toWebhookResponse(await target.process({ rawBody: new Uint8Array(await request.arrayBuffer()), headers: request.headers }));

const nodeHttpRecipe = async (request: AsyncIterable<Uint8Array> & { headers: Record<string, string | string[] | undefined> }, target: WebhookProcessor) => {
  const bytes: number[] = [];
  for await (const chunk of request) bytes.push(...chunk);
  return target.process({ rawBody: Uint8Array.from(bytes), headers: request.headers });
};

describe("documented raw-body recipes", () => {
  it("processes Web Request and Next.js route shapes", async () => {
    const fixture = await signedFixture("room.created");
    for (const _runtime of ["web", "next"] as const) {
      const request = new Request("https://receiver.invalid/chalk", { method: "POST", headers: fixture.headers, body: fixture.rawBody });
      expect((await webRequestRecipe(request, processor)).status).toBe(200);
    }
  });

  it("processes the Node HTTP async-iterable shape", async () => {
    const fixture = await signedFixture("session.started");
    const request = {
      headers: Object.fromEntries(fixture.headers),
      async *[Symbol.asyncIterator]() {
        yield fixture.rawBody.slice(0, 20);
        yield fixture.rawBody.slice(20);
      },
    };
    expect((await nodeHttpRecipe(request, processor)).status).toBe(200);
  });

  it("processes an Express raw middleware shape", async () => {
    const fixture = await signedFixture("participant.left");
    const expressRequest = { body: fixture.rawBody, headers: Object.fromEntries(fixture.headers) };
    expect((await processor.process({ rawBody: new Uint8Array(expressRequest.body), headers: expressRequest.headers })).status).toBe(200);
  });

  it("processes the Hono raw Request shape", async () => {
    const fixture = await signedFixture("endpoint.test");
    const context = { req: { raw: new Request("https://receiver.invalid/chalk", { method: "POST", headers: fixture.headers, body: fixture.rawBody }) } };
    expect((await webRequestRecipe(context.req.raw, processor)).status).toBe(200);
  });
});
