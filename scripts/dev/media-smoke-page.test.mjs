import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { createMediaSmokeInitScript } from "./media-smoke-page.mjs";

const generatedJourneyID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("media smoke page instrumentation", () => {
  it("scopes the generated journey header to same-origin public API paths", async () => {
    const page = createPage();

    await page.window.fetch("/v1/public/space-invite-arrivals", { method: "POST" });
    await page.window.fetch("/api/spaces");
    await page.window.fetch("http://127.0.0.1:8787/v1/public/space-invite-arrivals");
    await page.window.fetch("/v1/publicish/access");

    expect(headerFor(page.calls[0])).toBe(generatedJourneyID);
    expect(headerFor(page.calls[1])).toBeNull();
    expect(headerFor(page.calls[2])).toBeNull();
    expect(headerFor(page.calls[3])).toBeNull();
  });

  it("preserves a caller-provided journey header and Request identity", async () => {
    const page = createPage();
    const request = new Request("http://127.0.0.1:3070/v1/public/space-invite-arrivals", { method: "POST", body: "{}", headers: { "x-chalk-journey-id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });

    await page.window.fetch(request);

    expect(page.calls[0][0]).toBe(request);
    expect(page.calls[0]).toHaveLength(1);
    expect(headerFor(page.calls[0])).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("records one valid context journey ID in the tracker before fetches run", () => {
    const page = createPage();
    const journeyIDs = page.window.__chalkMediaSmoke.tracks().journeyIds;

    expect(journeyIDs).toEqual([generatedJourneyID]);
    expect(journeyIDs[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

function createPage() {
  const calls = [];
  const navigator = { mediaDevices: {} };
  const window = {
    fetch: (...args) => {
      calls.push(args);
      return Promise.resolve({ ok: true });
    },
    location: { origin: "http://127.0.0.1:3070", href: "http://127.0.0.1:3070/" },
    navigator,
    crypto: { randomUUID: () => generatedJourneyID },
    RTCPeerConnection: undefined,
    WebSocket: undefined,
    setInterval,
    clearInterval,
  };
  runInNewContext(createMediaSmokeInitScript(), {
    Headers,
    Request,
    URL,
    crypto: window.crypto,
    navigator,
    window,
  });
  return { calls, window };
}

function headerFor(args) {
  const [input, init] = args;
  return new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-chalk-journey-id");
}
