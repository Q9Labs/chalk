import assert from "node:assert/strict";
import test from "node:test";
import worker from "./pages-worker.mjs";

test("Pages sends assets through unchanged", async () => {
  const response = await worker.fetch(new Request("https://nightly.example.test/space/a"), { ASSETS: { fetch: async () => new Response("shell") } });
  assert.equal(await response.text(), "shell");
});

test("Pages rejects a nightly proxy bound to production", async () => {
  const response = await worker.fetch(new Request("https://nightly.example.test/api/me"), { CHALK_ENVIRONMENT: "nightly", CHALK_API_ORIGIN: "https://api.chalkmeet.com" });
  assert.equal(response.status, 503);
});

test("Pages preserves account path, query, cookies and manual redirects", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (request, options) => {
      assert.equal(request.url, "https://nightly-api.chalkmeet.com/api/me?x=1");
      assert.equal(request.headers.get("cookie"), "session=test-only");
      assert.equal(options.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "/login" } });
    };
    const response = await worker.fetch(new Request("https://nightly.example.test/api/me?x=1", { headers: { cookie: "session=test-only" } }), { CHALK_ENVIRONMENT: "nightly", CHALK_API_ORIGIN: "https://nightly-api.chalkmeet.com" });
    assert.equal(response.status, 302);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
