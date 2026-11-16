import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { proveSeededSignIn } from "./chalk-signin.mjs";

async function withArrivalServer(firstStatus, code, check) {
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
    if (arrivals === 1) {
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
  await withArrivalServer(409, "episode.not_active", async (origin) => {
    assert.deepEqual(await proveSeededSignIn({ origin, invite: { path: "/seeded-invite", code: "seeded-invite" }, retryDelayMs: 1 }), { state: "admitted" });
  });
});

test("a rejected invite is not retried as a transient Episode transition", async () => {
  await withArrivalServer(403, "invite.forbidden", async (origin, arrivals) => {
    await assert.rejects(proveSeededSignIn({ origin, invite: { path: "/seeded-invite", code: "seeded-invite" }, retryDelayMs: 1 }), /HTTP 403/);
    assert.equal(arrivals(), 1);
  });
});
