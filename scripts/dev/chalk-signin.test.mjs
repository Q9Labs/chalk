import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { proveSeededSignIn, waitForSeededSpaceIdle } from "./chalk-signin.mjs";
import { chalkSfuPlane } from "./config.mjs";

async function withArrivalServer(firstStatus, code, check, failures = 1) {
  let arrivals = 0;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html" }).end("<html></html>");
      return;
    }
    if (request.method === "DELETE") {
      response.writeHead(request.headers.cookie === "guest=proof" && request.headers["x-chalk-arrival-handle"] === "proof" ? 200 : 401).end();
      return;
    }
    arrivals++;
    if (arrivals <= failures) {
      response.writeHead(firstStatus, { "content-type": "application/json" }).end(JSON.stringify({ error: { code } }));
      return;
    }
    response.writeHead(201, { "content-type": "application/json", "set-cookie": "guest=proof; HttpOnly" }).end(JSON.stringify({ state: "admitted", arrival_handle: "proof", access: { media: { provider: chalkSfuPlane } } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await check(`http://127.0.0.1:${server.address().port}`, () => arrivals);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a reload proof survives the preceding guest's Episode ending", async () => {
  await withArrivalServer(
    409,
    "episode.not_active",
    async (origin) => {
      assert.deepEqual(await proveSeededSignIn({ origin, invite: { path: "/seeded-invite", code: "seeded-invite" }, retryDelayMs: 1 }), { state: "admitted" });
    },
    5,
  );
});

test("the boot browser waits for the Doctor guest's Episode to finish after reload", async () => {
  const statuses = ["active", "ending", "ended"];
  await waitForSeededSpaceIdle({
    origin: "http://chalk.example.test",
    seed: { tenantId: "tenant", spaceId: "space", systemToken: "test-token" },
    retryDelayMs: 1,
    fetchImpl: async (url, options) => {
      assert.equal(url.pathname + url.search, "/v1/tenants/tenant/spaces/space/episodes?page_size=1");
      assert.equal(options.headers.Authorization, "Bearer test-token");
      assert.ok(statuses.length > 0, "stops reading after the Episode ends");
      return Response.json({ episodes: [{ status: statuses.shift() }] });
    },
  });
  assert.deepEqual(statuses, []);
});

test("a rejected invite is not retried as a transient Episode transition", async () => {
  await withArrivalServer(403, "invite.forbidden", async (origin, arrivals) => {
    await assert.rejects(proveSeededSignIn({ origin, invite: { path: "/seeded-invite", code: "seeded-invite" }, retryDelayMs: 1 }), /HTTP 403/);
    assert.equal(arrivals(), 1);
  });
});

test("the dev stack rejects a grant for a retired provider", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    if (!options.method) return new Response("<html></html>", { headers: { "content-type": "text/html" } });
    if (options.method === "DELETE") return new Response(null, { status: 200 });
    return Response.json({ state: "admitted", arrival_handle: "proof", access: { media: { provider: "cf_sfu" } } }, { status: 201 });
  };
  await assert.rejects(
    proveSeededSignIn({
      origin: "https://3070-example.instabox.tech",
      invite: { path: "/seeded-invite", code: "seeded-invite" },
      fetchImpl,
    }),
    /expected chalk_sfu/,
  );
  assert.equal(calls[1].headers["X-Chalk-Media-Providers"], chalkSfuPlane);
  assert.equal(calls[2].method, "DELETE");
});
