import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { publicFailure, request } from "./runtime.mjs";
import { catcherRequest } from "./webhook-transport.mjs";

async function serve(status, contentType, body) {
  const server = createServer((_request, response) => response.writeHead(status, { "Content-Type": contentType }).end(body));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

async function publicLine(phase, failing) {
  const lines = [];
  try {
    await failing();
  } catch (error) {
    publicFailure(phase, error, (line) => lines.push(line));
  }
  return lines;
}

test("an edge error page from the API names its status instead of unknown", async () => {
  const edge = await serve(524, "text/html; charset=UTF-8", "<!DOCTYPE html><title>timeout</title>");
  try {
    const lines = await publicLine("setup-or-capture", () => request({ api_url: edge.url, web_url: edge.url }, "GET", "/v1/ping"));
    assert.deepEqual(lines, ["PROOF setup-or-capture: failed (api:524:unknown)"]);
  } finally {
    edge.close();
  }
});

test("an API error that is JSON keeps its code", async () => {
  const api = await serve(409, "application/json", JSON.stringify({ error: { code: "request.invalid" } }));
  try {
    const lines = await publicLine("setup-or-capture", () => request({ api_url: api.url, web_url: api.url }, "POST", "/v1/ping", {}));
    assert.deepEqual(lines, ["PROOF setup-or-capture: failed (api:409:request.invalid)"]);
  } finally {
    api.close();
  }
});

test("a webhook catcher that answers HTML or an error is named as the webhook transport", async () => {
  const html = await serve(200, "text/html", "<!DOCTYPE html>");
  const limited = await serve(429, "application/json", "{}");
  try {
    assert.deepEqual(await publicLine("setup-or-capture", () => catcherRequest(html.url, "/token", "POST", {})), ["PROOF setup-or-capture: failed (webhook-transport)"]);
    assert.deepEqual(await publicLine("setup-or-capture", () => catcherRequest(limited.url, "/token", "POST", {})), ["PROOF setup-or-capture: failed (webhook-transport)"]);
  } finally {
    html.close();
    limited.close();
  }
});
