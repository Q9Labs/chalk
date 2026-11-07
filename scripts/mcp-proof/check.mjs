import { pathToFileURL } from "node:url";

const protocolVersion = "2025-11-25";

function fail(step, detail) {
  throw new Error(`MCP check failed at ${step}: ${detail}`);
}

async function request(fetchImpl, step, url, init = {}) {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    return fail(step, `${init.method ?? "GET"} ${url} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function json(response, step) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return fail(step, `expected JSON from ${response.url}, got HTTP ${response.status}: ${text.slice(0, 200)}`);
  }
}

function rpc(fetchImpl, mcpUrl, apiKey, id, method, params, extraHeaders = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": protocolVersion,
    ...extraHeaders,
  };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  return request(fetchImpl, method, mcpUrl, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
}

const clientInfo = { name: "chalk-mcp-check", version: "1" };

function resourceMetadataUrl(anonymous) {
  const challenge = anonymous.headers.get("www-authenticate") ?? "";
  const url = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
  if (!url) fail("OAuth challenge", `WWW-Authenticate has no resource_metadata: "${challenge}"`);
  return url;
}

async function fetchAuthorizationServer(fetchImpl, mcpUrl, metadataUrl) {
  const resource = await json(await request(fetchImpl, "protected resource metadata", metadataUrl), "protected resource metadata");
  if (resource.resource !== mcpUrl) fail("protected resource metadata", `resource is ${resource.resource}, expected ${mcpUrl}`);
  const issuer = resource.authorization_servers?.[0];
  if (!issuer) fail("protected resource metadata", "no authorization_servers");
  return json(await request(fetchImpl, "authorization server metadata", `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`), "authorization server metadata");
}

function checkAuthorizationServer(server) {
  const missing = ["authorization_endpoint", "token_endpoint", "registration_endpoint"].filter((key) => !server[key]);
  if (missing.length > 0) fail("authorization server metadata", `missing ${missing.join(", ")}`);
  if (!server.code_challenge_methods_supported?.includes("S256")) fail("authorization server metadata", "PKCE S256 is not advertised");
}

async function checkOAuthDiscovery(fetchImpl, mcpUrl, anonymous) {
  checkAuthorizationServer(await fetchAuthorizationServer(fetchImpl, mcpUrl, resourceMetadataUrl(anonymous)));
}

/** Returns the headers every later request must carry, such as the session id. */
async function checkInitialize(fetchImpl, mcpUrl, apiKey) {
  const response = await rpc(fetchImpl, mcpUrl, apiKey, 2, "initialize", { protocolVersion, capabilities: {}, clientInfo });
  const body = await json(response, "initialize");
  if (response.status !== 200 || !body.result?.serverInfo) fail("initialize", `HTTP ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return sessionHeaders(response);
}

function sessionHeaders(response) {
  const session = response.headers.get("mcp-session-id");
  return session ? { "mcp-session-id": session } : {};
}

async function checkToolList(fetchImpl, mcpUrl, apiKey, sessionHeaders) {
  const listed = await json(await rpc(fetchImpl, mcpUrl, apiKey, 3, "tools/list", {}, sessionHeaders), "tools/list");
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  if (!names.includes("chalk_list_spaces")) fail("tools/list", `expected chalk_list_spaces among ${names.length} tools`);
  return names.length;
}

function toolSucceeded(status, result) {
  return status === 200 && !result.error && result.result && !result.result.isError;
}

async function checkToolCall(fetchImpl, mcpUrl, apiKey, headers) {
  const called = await rpc(fetchImpl, mcpUrl, apiKey, 4, "tools/call", { name: "chalk_list_spaces", arguments: {} }, headers);
  const result = await json(called, "tools/call chalk_list_spaces");
  if (!toolSucceeded(called.status, result)) fail("tools/call chalk_list_spaces", `HTTP ${called.status}: ${JSON.stringify(result).slice(0, 300)}`);
}

/** Runs the checks a person connecting an MCP client would hit, in order. Returns the step names that passed. */
export async function checkMcp({ apiUrl, apiKey, expectOAuth, fetchImpl = fetch }) {
  const mcpUrl = `${apiUrl.replace(/\/+$/, "")}/mcp`;
  const passed = [];

  const anonymous = await rpc(fetchImpl, mcpUrl, undefined, 1, "initialize", { protocolVersion, capabilities: {}, clientInfo });
  if (anonymous.status !== 401) fail("anonymous initialize", `expected HTTP 401 from ${mcpUrl}, got ${anonymous.status}`);
  passed.push("anonymous request is refused with 401");

  if (expectOAuth) {
    await checkOAuthDiscovery(fetchImpl, mcpUrl, anonymous);
    passed.push("OAuth discovery publishes resource, authorization server and S256");
  }

  const sessionHeaders = await checkInitialize(fetchImpl, mcpUrl, apiKey);
  passed.push("initialize with the API key");
  passed.push(`tools/list returns ${await checkToolList(fetchImpl, mcpUrl, apiKey, sessionHeaders)} tools`);
  await checkToolCall(fetchImpl, mcpUrl, apiKey, sessionHeaders);
  passed.push("authenticated tool call lists the proof tenant's Spaces");
  return passed;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail("configuration", `${name} is not set`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const passed = await checkMcp({
    apiUrl: requiredEnv("CHALK_PROOF_API_URL"),
    apiKey: requiredEnv("CHALK_PROOF_API_KEY"),
    expectOAuth: process.env.CHALK_MCP_EXPECT_OAUTH !== "false",
  }).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
  for (const step of passed) console.log(`ok: ${step}`);
}
