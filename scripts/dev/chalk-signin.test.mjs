import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { proveSeededSignIn } from "./chalk-signin.mjs";

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
    response.writeHead(201, { "content-type": "application/json", "set-cookie": "guest=proof; HttpOnly" }).end(JSON.stringify({ state: "admitted", arrival_handle: "proof" }));
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

test("a rejected invite is not retried as a transient Episode transition", async () => {
  await withArrivalServer(403, "invite.forbidden", async (origin, arrivals) => {
    await assert.rejects(proveSeededSignIn({ origin, invite: { path: "/seeded-invite", code: "seeded-invite" }, retryDelayMs: 1 }), /HTTP 403/);
    assert.equal(arrivals(), 1);
  });
});

test("an Orb admits the seeded guest on Chalk SFU, never on Cloudflare", async () => {
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
      mediaPlane: "chalk_sfu",
      fetchImpl,
    }),
    /expected chalk_sfu/,
  );
  assert.equal(calls[1].headers["X-Chalk-Media-Providers"], "chalk_sfu");
  assert.equal(calls[2].method, "DELETE");
});
