import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { checkMcp } from "./check.mjs";

const tenantId = "ten_proof";

function startServer({ routes = true, oauth = true } = {}) {
  const server = createServer((req, res) => {
    const origin = `http://${req.headers.host}`;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (!routes) return send(404, { error: { code: "route.not_found" } });
    if (req.url === "/.well-known/oauth-protected-resource/mcp") return send(200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (req.url === "/.well-known/oauth-authorization-server") {
      return send(200, { authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, code_challenge_methods_supported: ["S256"] });
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const message = JSON.parse(body);
      if (req.headers.authorization !== "Bearer key") {
        const challenge = oauth ? { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } : {};
        return send(401, { error: { code: "auth.unauthenticated" } }, challenge);
      }
      if (message.method === "initialize") return send(200, { jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "chalk" } } });
      if (message.method === "tools/list") return send(200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "chalk_get_connection" }, { name: "chalk_list_spaces" }] } });
      return send(200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `tenant ${tenantId}` }] } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

test("passes against a healthy server with OAuth", async () => {
  const { server, url } = await startServer();
  try {
    const passed = await checkMcp({ apiUrl: url, apiKey: "key", tenantId, expectOAuth: true });
    assert.equal(passed.length, 5);
  } finally {
    server.close();
  }
});

test("a server without MCP routes (the 404 regression) fails at the first step", async () => {
  const { server, url } = await startServer({ routes: false });
  try {
    await assert.rejects(checkMcp({ apiUrl: url, apiKey: "key", tenantId, expectOAuth: true }), /anonymous initialize.*got 404/);
  } finally {
    server.close();
  }
});

test("missing OAuth discovery fails when OAuth is expected and passes when it is not", async () => {
  const { server, url } = await startServer({ oauth: false });
  try {
    await assert.rejects(checkMcp({ apiUrl: url, apiKey: "key", tenantId, expectOAuth: true }), /no resource_metadata/);
    assert.equal((await checkMcp({ apiUrl: url, apiKey: "key", tenantId, expectOAuth: false })).length, 4);
  } finally {
    server.close();
  }
});

test("a rejected API key fails at initialize", async () => {
  const { server, url } = await startServer();
  try {
    await assert.rejects(checkMcp({ apiUrl: url, apiKey: "wrong", tenantId, expectOAuth: true }), /initialize/);
  } finally {
    server.close();
  }
});
