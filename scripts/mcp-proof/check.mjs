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

/** Runs the checks a person connecting an MCP client would hit, in order. Returns the step names that passed. */
export async function checkMcp({ apiUrl, apiKey, expectOAuth, fetchImpl = fetch }) {
  const base = apiUrl.replace(/\/+$/, "");
  const mcpUrl = `${base}/mcp`;
  const passed = [];
  const pass = (step) => passed.push(step);

  const anonymous = await rpc(fetchImpl, mcpUrl, undefined, 1, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "chalk-mcp-check", version: "1" },
  });
  if (anonymous.status !== 401) fail("anonymous initialize", `expected HTTP 401 from ${mcpUrl}, got ${anonymous.status}`);
  pass("anonymous request is refused with 401");

  if (expectOAuth) {
    const challenge = anonymous.headers.get("www-authenticate") ?? "";
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
    if (!metadataUrl) fail("OAuth challenge", `WWW-Authenticate has no resource_metadata: ${challenge || "(missing)"}`);
    const resource = await json(await request(fetchImpl, "protected resource metadata", metadataUrl), "protected resource metadata");
    if (resource.resource !== mcpUrl) fail("protected resource metadata", `resource is ${resource.resource}, expected ${mcpUrl}`);
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) fail("protected resource metadata", "no authorization_servers");
    const server = await json(await request(fetchImpl, "authorization server metadata", `${issuer.replace(/\/+$/, "")}/.well-known/oauth-authorization-server`), "authorization server metadata");
    for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"]) {
      if (!server[key]) fail("authorization server metadata", `missing ${key}`);
    }
    if (!server.code_challenge_methods_supported?.includes("S256")) fail("authorization server metadata", "PKCE S256 is not advertised");
    pass("OAuth discovery publishes resource, authorization server and S256");
  }

  const initialized = await rpc(fetchImpl, mcpUrl, apiKey, 2, "initialize", {
    protocolVersion,
    capabilities: {},
    clientInfo: { name: "chalk-mcp-check", version: "1" },
  });
  const init = await json(initialized, "initialize");
  if (initialized.status !== 200 || !init.result?.serverInfo) fail("initialize", `HTTP ${initialized.status}: ${JSON.stringify(init).slice(0, 300)}`);
  pass("initialize with the API key");

  const session = initialized.headers.get("mcp-session-id");
  const sessionHeaders = session ? { "mcp-session-id": session } : {};
  const listed = await json(await rpc(fetchImpl, mcpUrl, apiKey, 3, "tools/list", {}, sessionHeaders), "tools/list");
  const names = (listed.result?.tools ?? []).map((tool) => tool.name);
  if (!names.includes("chalk_list_spaces")) fail("tools/list", `expected chalk_list_spaces among ${names.length} tools`);
  pass(`tools/list returns ${names.length} tools`);

  const called = await rpc(fetchImpl, mcpUrl, apiKey, 4, "tools/call", { name: "chalk_list_spaces", arguments: {} }, sessionHeaders);
  const result = await json(called, "tools/call chalk_list_spaces");
  if (called.status !== 200 || result.error || !result.result || result.result.isError) fail("tools/call chalk_list_spaces", `HTTP ${called.status}: ${JSON.stringify(result).slice(0, 300)}`);
  pass("authenticated tool call lists the proof tenant's Spaces");
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
