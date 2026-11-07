import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkMcp } from "./check.mjs";

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function discovery(url, origin) {
  if (url === "/.well-known/oauth-protected-resource/mcp") return { resource: `${origin}/mcp`, authorization_servers: [origin] };
  if (url === "/.well-known/oauth-authorization-server") {
    return { authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, code_challenge_methods_supported: ["S256"] };
  }
  return undefined;
}

function answer(message, { toolStatus }) {
  if (message.method === "initialize") return [200, { jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "chalk" } } }];
  if (message.method === "tools/list") return [200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "chalk_inspect_spaces" }] } }];
  return [toolStatus, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "[]" }] } }];
}

function startServer({ routes = true, oauth = true, toolStatus = 200 } = {}) {
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    if (!routes) return reply(res, 404, { error: { code: "route.not_found" } });
    const metadata = discovery(req.url, origin);
    if (metadata) return reply(res, 200, metadata);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer key") {
        const challenge = oauth ? { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } : {};
        return reply(res, 401, { error: { code: "auth.unauthenticated" } }, challenge);
      }
      const [status, payload] = answer(JSON.parse(body), { toolStatus });
      reply(res, status, payload);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test("passes against a healthy server with OAuth", async () => {
  const { server, url } = await startServer();
  try {
    const passed = await checkMcp({ apiUrl: url, apiKey: "key", expectOAuth: true });
    assert.equal(passed.length, 5);
  } finally {
    server.close();
  }
});

test("a server without MCP routes (the 404 regression) fails at the first step", async () => {
  const { server, url } = await startServer({ routes: false });
  try {
    await assert.rejects(checkMcp({ apiUrl: url, apiKey: "key", expectOAuth: true }), /anonymous initialize.*got 404/);
  } finally {
    server.close();
  }
});

test("missing OAuth discovery fails when OAuth is expected and passes when it is not", async () => {
  const { server, url } = await startServer({ oauth: false });
  try {
    await assert.rejects(checkMcp({ apiUrl: url, apiKey: "key", expectOAuth: true }), /no resource_metadata/);
    assert.equal((await checkMcp({ apiUrl: url, apiKey: "key", expectOAuth: false })).length, 4);
  } finally {
    server.close();
  }
});

test("a failed tool call fails the check", async () => {
  const { server, url } = await startServer({ toolStatus: 500 });
  try {
    await assert.rejects(checkMcp({ apiUrl: url, apiKey: "key", expectOAuth: true }), /tools\/call chalk_inspect_spaces.*HTTP 500/);
  } finally {
    server.close();
  }
});

test("a rejected API key fails at initialize", async () => {
  const { server, url } = await startServer();
  try {
    await assert.rejects(checkMcp({ apiUrl: url, apiKey: "wrong", expectOAuth: true }), /initialize/);
  } finally {
    server.close();
  }
});
