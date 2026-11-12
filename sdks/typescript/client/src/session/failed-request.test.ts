import { describe, expect, it } from "vitest";
import { lastFailedRequest, withRequestContext } from "./index";

const JOURNEY_ID = "0198a1b2-c3d4-4e5f-8a9b-0c1d2e3f4a5c";

const reply = (status: number, headers: Record<string, string>) => async () => new Response("{}", { status, headers });

describe("failed request journey", () => {
  it("keeps the journey ID of the latest failed response and sends none of its own", async () => {
    let sent: Headers | undefined;
    const fetch = withRequestContext(async (_input, init) => {
      sent = new Headers(init?.headers);
      return new Response("{}", { status: 409, headers: { "x-chalk-journey-id": JOURNEY_ID } });
    });
    await fetch("https://api.example.test/v1/join");
    expect(lastFailedRequest()).toEqual({ journeyId: JOURNEY_ID, status: 409 });
    expect(sent?.has("x-chalk-journey-id")).toBe(false);
  });

  it("ignores successful responses and header values that are not IDs", async () => {
    await withRequestContext(reply(500, { "x-chalk-journey-id": JOURNEY_ID }))("https://api.example.test/a");
    await withRequestContext(reply(200, { "x-chalk-journey-id": "0198a1b2-c3d4-4e5f-8a9b-000000000000" }))("https://api.example.test/b");
    await withRequestContext(reply(403, { "x-chalk-journey-id": "free text with secrets" }))("https://api.example.test/c");
    expect(lastFailedRequest()).toEqual({ journeyId: JOURNEY_ID, status: 500 });
  });
});
