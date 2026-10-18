import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { catcherRequest } from "./webhook-transport.mjs";

async function withServer(handler, run) {
  const server = createServer(handler).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("a failed catcher read recovers from a dropped connection", async () => {
  let requests = 0;
  await withServer(
    (request, response) => {
      if (++requests === 1) request.socket.destroy();
      else response.end('{"data":[]}');
    },
    async (base) => {
      assert.deepEqual(await (await catcherRequest(base, "/requests")).json(), { data: [] });
      assert.equal(requests, 2);
    },
  );
});

test("persistent connection failures stop after three attempts", async () => {
  let requests = 0;
  await withServer(
    (request) => {
      requests++;
      request.socket.destroy();
    },
    async (base) => {
      await assert.rejects(catcherRequest(base, "/requests"), /fetch failed/);
      assert.equal(requests, 3);
    },
  );
});

test("writes are not retried after a dropped connection", async () => {
  let requests = 0;
  await withServer(
    (request) => {
      requests++;
      request.socket.destroy();
    },
    async (base) => {
      await assert.rejects(catcherRequest(base, "/token", "POST", {}), /fetch failed/);
      assert.equal(requests, 1);
    },
  );
});

test("a rejected catcher read still fails without retries", async () => {
  let requests = 0;
  await withServer(
    (request, response) => {
      requests++;
      response.writeHead(403).end();
    },
    async (base) => {
      await assert.rejects(catcherRequest(base, "/requests"), /HTTP 403/);
      assert.equal(requests, 1);
    },
  );
});

test("cancellation stops catcher reads", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(catcherRequest("http://127.0.0.1:1", "/requests", "GET", undefined, controller.signal), { name: "AbortError" });
});
