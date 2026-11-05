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
      assert.deepEqual(await catcherRequest(base, "/requests"), { data: [] });
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

for (const responseType of ["json", "arrayBuffer"]) {
  test(`a catcher ${responseType} read recovers from a mid-body disconnect`, async () => {
    let requests = 0;
    await withServer(
      (request, response) => {
        response.writeHead(200, { "Content-Length": 11 });
        if (++requests === 1) {
          response.write('{"data":');
          setTimeout(() => response.destroy(), 25);
        } else response.end('{"data":[]}');
      },
      async (base) => {
        const result = await catcherRequest(base, "/requests", "GET", undefined, undefined, responseType);
        if (responseType === "json") assert.deepEqual(result, { data: [] });
        else assert.equal(Buffer.from(result).toString(), '{"data":[]}');
        assert.equal(requests, 2);
      },
    );
  });
}

for (const retryAfter of ["12", new Date(12_000).toUTCString()]) {
  test(`a quota-limited GET honours Retry-After ${retryAfter} before recovering`, async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
    const requests = [];
    t.mock.method(globalThis, "fetch", async () => {
      requests.push(Date.now());
      return requests.length === 1 ? new Response(null, { status: 429, headers: { "Retry-After": retryAfter } }) : Response.json({ data: [] });
    });
    const result = catcherRequest("https://catcher.example.test", "/requests");
    await new Promise(setImmediate);
    t.mock.timers.tick(11_999);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1, "must not retry before the service permits it");
    t.mock.timers.tick(1);
    assert.deepEqual(await result, { data: [] });
    assert.deepEqual(requests, [0, 12_000]);
  });
}

test("transient server errors use exponential backoff when Retry-After is invalid or absent", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const requests = [];
  t.mock.method(globalThis, "fetch", async () => {
    requests.push(Date.now());
    if (requests.length === 1) return new Response(null, { status: 503, headers: { "Retry-After": "invalid" } });
    if (requests.length === 2) return new Response(null, { status: 502 });
    return Response.json({ data: [] });
  });
  const result = catcherRequest("https://catcher.example.test", "/requests");
  await new Promise(setImmediate);
  t.mock.timers.tick(1000);
  await new Promise(setImmediate);
  t.mock.timers.tick(2000);
  assert.deepEqual(await result, { data: [] });
  assert.deepEqual(requests, [0, 1000, 3000]);
});

test("persistent throttling exhausts a single total budget instead of restarting it per retry", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  });
  const result = assert.rejects(catcherRequest("https://catcher.example.test", "/requests"), /HTTP 429; retry budget exhausted/);
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000);
  await new Promise(setImmediate);
  t.mock.timers.tick(30_000);
  await result;
  assert.equal(requests, 3);
  assert.equal(Date.now(), 60_000);
});

test("Retry-After beyond the budget fails without retrying early", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(null, { status: 503, headers: { "Retry-After": "120" } });
  });
  await assert.rejects(catcherRequest("https://catcher.example.test", "/requests"), /HTTP 503; retry budget exhausted/);
  assert.equal(requests, 1);
});

test("cancellation interrupts quota backoff without another request", async (t) => {
  const controller = new AbortController();
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  });
  const result = assert.rejects(catcherRequest("https://catcher.example.test", "/requests", "GET", undefined, controller.signal), { name: "AbortError" });
  await new Promise(setImmediate);
  controller.abort();
  await result;
  assert.equal(requests, 1);
});

test("a throttled write fails immediately instead of risking duplicate creation", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    return new Response(null, { status: 429, headers: { "Retry-After": "30" } });
  });
  await assert.rejects(catcherRequest("https://catcher.example.test", "/token", "POST", {}), /HTTP 429/);
  assert.equal(requests, 1);
});
