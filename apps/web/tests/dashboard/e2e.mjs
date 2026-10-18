import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// The only engine stub implements the two not-yet-landed provisioning calls.
const tenants = new Map();
const requests = [];
const unsupportedBodies = [];
const engine = createServer(async (request, response) => {
  requests.push(request.url);
  const url = new URL(request.url, "http://localhost");
  response.setHeader("Content-Type", "application/json");
  if (request.headers.authorization !== "Bearer fixture-service-not-a-secret") {
    response.writeHead(401).end("{}");
    return;
  }
  if (request.method === "GET" && url.pathname === "/v1/tenants/by-external-id") {
    const tenant = tenants.get(url.searchParams.get("external_id"));
    response.writeHead(tenant ? 200 : 404).end(JSON.stringify(tenant ?? {}));
    return;
  }
  if (request.method === "POST" && url.pathname === "/v1/tenants") {
    let body = "";
    for await (const part of request) body += part;
    const input = JSON.parse(body);
    let tenant = tenants.get(input.external_id);
    if (!tenant) {
      tenant = { id: crypto.randomUUID() };
      tenants.set(input.external_id, tenant);
    }
    response.writeHead(201).end(JSON.stringify(tenant));
    return;
  }
  let unsupportedBody = "";
  for await (const part of request) unsupportedBody += part;
  unsupportedBodies.push({ method: request.method, path: url.pathname, body: unsupportedBody });
  response.writeHead(501).end(JSON.stringify({ error: { code: "test.operation_not_stubbed" } }));
});
const sandbox = await mkdtemp(resolve(tmpdir(), "chalk-dashboard-pages-"));
const web = resolve(import.meta.dirname, "../..");
let pages;
let watchdog;
let pagesOutput = "";
const deadline = setTimeout(() => {
  pages?.kill("SIGTERM");
  engine.close();
  process.exitCode = 1;
}, 120000);
try {
  await mkdir(resolve(sandbox, "functions"));
  await mkdir(resolve(sandbox, "public"));
  await writeFile(resolve(sandbox, "public/index.html"), "fixture boundary");
  // Run the real named Pages route graph with a test-only composition root.
  for (const group of ["auth", "dashboard-api"]) {
    const names = group === "auth" ? ["start", "callback", "session", "refresh", "sign-out"] : ["home", "call", "past-session", "developer"];
    await mkdir(resolve(sandbox, "functions", group));
    for (const name of names) {
      const original = await readFile(resolve(web, "functions", group, `${name}.ts`), "utf8");
      const entry = relative(resolve(sandbox, "functions", group), resolve(import.meta.dirname, "fixture-entry.ts"));
      await writeFile(resolve(sandbox, "functions", group, `${name}.ts`), original.replace("../../server/production", entry));
    }
  }
  await mkdir(resolve(sandbox, "functions/fixture"));
  const entry = relative(resolve(sandbox, "functions/fixture"), resolve(import.meta.dirname, "fixture-entry.ts"));
  await writeFile(resolve(sandbox, "functions/fixture/[[path]].ts"), `export { onRequest } from ${JSON.stringify(entry)};\n`);
  engine.listen(0, "127.0.0.1");
  await once(engine, "listening");
  const portProbe = createServer();
  await new Promise((ready, reject) => portProbe.once("error", reject).listen(0, "127.0.0.1", ready));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const bindings = {
    CHALK_ENVIRONMENT: "test",
    CHALK_API_ORIGIN: `http://127.0.0.1:${engine.address().port}`,
    DASHBOARD_ORIGIN: origin,
    WORKOS_REDIRECT_URI: `${origin}/auth/callback`,
    WORKOS_CLIENT_ID: "fixture-client",
    WORKOS_API_KEY: "fixture-workos-not-a-secret",
    WORKOS_COOKIE_PASSWORD: "fixture-only-cookie-password-32-characters",
    DASHBOARD_SERVICE_TOKEN: "fixture-service-not-a-secret",
    DASHBOARD_IDENTITY_PROVIDER: "fixture",
  };
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  pages = spawn(
    command,
    ["exec", "wrangler", "pages", "dev", "public", "--cwd", sandbox, "--port", `${port}`, "--inspector-port", "0", "--compatibility-date", "2024-12-01", "--compatibility-flags", "nodejs_compat", ...Object.entries(bindings).flatMap(([key, value]) => ["--binding", `${key}=${value}`])],
    { cwd: web, env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "true" }, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  pages.stdout.on("data", (chunk) => {
    pagesOutput += chunk;
  });
  pages.stderr.on("data", (chunk) => {
    pagesOutput += chunk;
  });
  // Separate owner-loss watcher reaps only this task's process group.
  watchdog = spawn(process.execPath, ["-e", `const owner=${process.pid},group=${pages.pid};setInterval(()=>{try{process.kill(owner,0)}catch{try{process.kill(-group,'SIGTERM')}catch{}process.exit()}},1000).unref();setTimeout(()=>{try{process.kill(-group,'SIGTERM')}catch{}},125000);`], {
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (pages.exitCode !== null) throw new Error(`Pages exited: ${pagesOutput}`);
    try {
      const response = await fetch(`${origin}/auth/session`);
      if (response.status === 401) break;
    } catch {}
    if (attempt === 99) throw new Error(`Pages did not become ready: ${pagesOutput}`);
    await delay(200);
  }
  console.log("Worker fetch compatibility:", await (await fetch(`${origin}/fixture/runtime-check`)).json());
  function browser() {
    const cookies = new Map();
    return {
      cookies,
      async request(path, options = {}) {
        const response = await fetch(new URL(path, origin), { ...options, redirect: "manual", headers: { Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join("; "), ...options.headers } });
        for (const cookie of response.headers.getSetCookie()) {
          const [key, ...rest] = cookie.split(";")[0].split("=");
          const value = rest.join("=");
          if (value) cookies.set(key, value);
          else cookies.delete(key);
        }
        assert.equal(response.headers.get("cache-control"), "no-store");
        return response;
      },
    };
  }
  async function signIn(client, person) {
    const start = await client.request("/auth/start?provider=google");
    assert.equal(start.status, 303);
    const authorize = new URL(start.headers.get("location"));
    authorize.searchParams.set("person", person);
    const authorized = await client.request(authorize);
    assert.equal(authorized.status, 303);
    const callback = authorized.headers.get("location");
    const loginCookie = client.cookies.get("local_chalk_login");
    const finished = await client.request(callback);
    assert.equal(finished.status, 303, `Callback ${await finished.text()}; engine paths ${JSON.stringify(requests)}`);
    assert.equal(finished.headers.get("location"), "/dashboard");
    assert.equal((await client.request(callback)).status, 400);
    client.cookies.set("local_chalk_login", loginCookie);
    assert.equal((await client.request(callback)).status, 401);
    const response = await client.request("/auth/session");
    assert.equal(response.status, 200);
    const dto = await response.json();
    assert.deepEqual(Object.keys(dto).sort(), ["csrfToken", "profile"]);
    assert(!JSON.stringify(dto).includes("fixture-service-not-a-secret"));
    assert(!JSON.stringify(dto).includes("fixture-workos-not-a-secret"));
    return dto;
  }
  async function post(client, path, value, token, extra = {}) {
    return client.request(path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token, ...extra }, body: JSON.stringify(value) });
  }
  const ada = browser();
  let session = await signIn(ada, "ada");
  assert.equal(tenants.size, 1);
  const firstTenant = [...tenants.values()][0].id;
  await signIn(ada, "ada");
  assert.equal(tenants.size, 1);
  assert.equal([...tenants.values()][0].id, firstTenant);
  session = await (await ada.request("/auth/session")).json();
  const malik = browser();
  const other = await signIn(malik, "malik");
  assert.equal(tenants.size, 2);
  const secondTenant = [...tenants.values()].find((tenant) => tenant.id !== firstTenant).id;
  assert.notEqual(other.csrfToken, session.csrfToken);
  assert.equal((await ada.request("/auth/start?provider=google&returnTo=https%3A%2F%2Fevil.example")).status, 400);
  assert.equal((await ada.request("/auth/start?provider=google&returnTo=%2F%2Fevil.example")).status, 400);
  const count = requests.length;
  assert.equal((await post(ada, "/dashboard-api/home", {}, session.csrfToken, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await post(ada, "/dashboard-api/home", {}, "")).status, 403);
  assert.equal((await post(ada, "/dashboard-api/home", {}, other.csrfToken)).status, 403);
  assert.equal(requests.length, count);
  // Missing engine operations are not mocked: they reject with 501. This proves
  // the BFF's Tenant path binding for foreign IDs, not the engine's permissions.
  const malikTenant = tenants.get("workos:test:fixture_malik").id;
  const foreign = { spaceId: crypto.randomUUID(), episodeId: crypto.randomUUID(), recordingId: crypto.randomUUID(), transcriptId: crypto.randomUUID(), keyId: crypto.randomUUID(), webhookId: crypto.randomUUID(), deliveryId: crypto.randomUUID() };
  const mutations = [
    ["home", { action: "rename-call", spaceId: foreign.spaceId, name: "Renamed" }],
    ["home", { action: "set-admission", spaceId: foreign.spaceId, admission: "knock" }],
    ["home", { action: "archive-call", spaceId: foreign.spaceId }],
    ["home", { action: "restore-call", spaceId: foreign.spaceId }],
    ["call", { action: "join", spaceId: foreign.spaceId, idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "rotate-link", spaceId: foreign.spaceId, idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "end-for-everyone", spaceId: foreign.spaceId, episodeId: foreign.episodeId, idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "approve-knock", spaceId: foreign.spaceId, requestHandle: "foreign_request_handle", idempotencyKey: crypto.randomUUID() }],
    ["call", { action: "deny-knock", spaceId: foreign.spaceId, requestHandle: "foreign_request_handle", idempotencyKey: crypto.randomUUID() }],
    ...["recording-url", "export-recording", "transcripts"].map((action) => [
      "past-session",
      { action, spaceId: foreign.spaceId, episodeId: foreign.episodeId, recordingId: foreign.recordingId, ...(action === "recording-url" ? { download: true } : action === "export-recording" ? { idempotencyKey: crypto.randomUUID() } : {}) },
    ]),
    ...["transcript-document", "transcript-url", "delete-transcript"].map((action) => ["past-session", { action, spaceId: foreign.spaceId, episodeId: foreign.episodeId, transcriptId: foreign.transcriptId }]),
    ["developer", { action: "rotate-key", keyId: foreign.keyId, expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "revoke-key", keyId: foreign.keyId }],
    ["developer", { action: "update-webhook", webhookId: foreign.webhookId, name: "Test", url: "https://example.test/hook", enabled: true, eventTypes: ["episode.ended"], revision: 1, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "delete-webhook", webhookId: foreign.webhookId, revision: 1, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "rotate-webhook-secret", webhookId: foreign.webhookId, revokePreviousImmediately: true, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "test-webhook", webhookId: foreign.webhookId, idempotencyKey: crypto.randomUUID() }],
    ["developer", { action: "webhook-deliveries", webhookId: foreign.webhookId }],
    ["developer", { action: "webhook-delivery", webhookId: foreign.webhookId, deliveryId: foreign.deliveryId }],
    ["developer", { action: "redeliver-webhook", webhookId: foreign.webhookId, deliveryId: foreign.deliveryId, idempotencyKey: crypto.randomUUID() }],
  ];
  for (const [page, action] of mutations) {
    const offset = requests.length;
    const response = await post(malik, `/dashboard-api/${page}`, action, other.csrfToken);
    assert(response.status >= 400, `${action.action} unexpectedly succeeded against an unimplemented engine`);
    const attempted = requests.slice(offset).filter((path) => path.startsWith("/v1/tenants/") && !path.startsWith("/v1/tenants/by-external-id"));
    assert(attempted.length > 0, `${action.action} did not exercise an engine path`);
    assert(
      attempted.every((path) => path.startsWith(`/v1/tenants/${malikTenant}/`)),
      `${action.action} escaped the authenticated Tenant`,
    );
    assert(!attempted.some((path) => path.includes(firstTenant)));
  }
  assert.equal((await post(malik, "/dashboard-api/call", { action: "refresh-access", spaceId: foreign.spaceId, participantId: foreign.recordingId }, other.csrfToken)).status, 400);
  assert.equal((await post(malik, "/dashboard-api/home", { action: "archive-call", spaceId: foreign.spaceId, tenantId: firstTenant }, other.csrfToken)).status, 400);

  assert.equal((await post(malik, "/dashboard-api/developer", { action: "set-allowed-websites", origins: ["https://example.test", "http://localhost:3000"] }, other.csrfToken)).status, 502);
  assert.deepEqual(unsupportedBodies.at(-1), { method: "PATCH", path: `/v1/tenants/${secondTenant}`, body: JSON.stringify({ cors_allowed_origins: ["https://chalkmeet.com", "https://example.test", "http://localhost:3000"] }) });
  assert.equal((await post(malik, "/dashboard-api/developer", { action: "allowed-websites" }, other.csrfToken)).status, 502);
  assert.equal(unsupportedBodies.at(-1).path, `/v1/tenants/${secondTenant}`);
  for (const invalid of ["http://example.test:8080", "http://localhost", "https://example.test/path", "https://user@example.test", "https://example.test?query", "http://127.0.0.1:3000"]) {
    assert.equal((await post(ada, "/dashboard-api/developer", { action: "set-allowed-websites", origins: [invalid] }, session.csrfToken)).status, 400, invalid);
  }
  await fetch(`${origin}/fixture/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person: "ada", expire: true }) });
  const expired = await ada.request("/auth/session");
  assert.equal(expired.status, 401);
  const bootstrap = await expired.json();
  assert.equal(bootstrap.error.code, "refresh_or_sign_in_required");
  assert.equal(typeof bootstrap.csrfToken, "string");
  session = { csrfToken: bootstrap.csrfToken };
  const before = ada.cookies.get("local_chalk_session");
  assert.equal((await post(ada, "/auth/refresh", {}, session.csrfToken)).status, 200);
  assert.notEqual(ada.cookies.get("local_chalk_session"), before);
  await fetch(`${origin}/fixture/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person: "ada", refresh: "transient", online: false }) });
  const preserved = ada.cookies.get("local_chalk_session");
  assert.equal((await post(ada, "/auth/refresh", {}, session.csrfToken)).status, 503);
  assert.equal(ada.cookies.get("local_chalk_session"), preserved);
  const sensitive = [
    { action: "set-allowed-websites", origins: ["https://example.test"] },
    { action: "update-webhook", webhookId: crypto.randomUUID(), name: "Test", url: "https://example.test/hook", enabled: true, eventTypes: ["episode.ended"], revision: 1, idempotencyKey: crypto.randomUUID() },
    { action: "create-key", name: "Test", scopes: ["spaces:read"], expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() },
    { action: "create-webhook", name: "Test", url: "https://example.test/hook", enabled: true, eventTypes: ["episode.ended"], idempotencyKey: crypto.randomUUID() },
  ];
  const sensitiveOffset = requests.length;
  const sensitiveBodyOffset = unsupportedBodies.length;
  for (const action of sensitive) assert.equal((await post(ada, "/dashboard-api/developer", action, session.csrfToken)).status, 401);
  assert.equal(unsupportedBodies.length, sensitiveBodyOffset);
  assert(!requests.slice(sensitiveOffset).some((path) => /api-keys|webhook-endpoints/.test(path)));
  assert.equal((await post(ada, "/auth/sign-out", {}, session.csrfToken)).status, 200);
  assert.equal((await ada.request("/auth/session")).status, 401);
  await fetch(`${origin}/fixture/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person: "malik", refresh: "terminal" }) });
  assert.equal((await post(malik, "/auth/refresh", {}, other.csrfToken)).status, 401);
  assert.equal(malik.cookies.size, 0);
  console.log("PASS: real Pages auth, two identities, idempotent Tenant bootstrap, callback replay, return URLs, exact Origin, CSRF, refresh success/transient/terminal, online-gated secrets, sign-out");
  console.log("PASS: foreign resource IDs stay under the authenticated Tenant path across named mutations; forged Tenant/Participant fields rejected. NOT COVERED: real-engine account isolation/artifacts; requires service-principal lane integration. Only provisioning calls are stubbed here.");
} catch (error) {
  await delay(200);
  console.error(pagesOutput.slice(-8000));
  throw error;
} finally {
  clearTimeout(deadline);
  watchdog?.kill("SIGTERM");
  if (pages?.pid) {
    try {
      process.kill(-pages.pid, "SIGTERM");
    } catch {}
    await Promise.race([once(pages, "exit"), delay(3000)]);
    try {
      process.kill(-pages.pid, "SIGKILL");
    } catch {}
  }
  await new Promise((resolve) => engine.close(resolve));
  await rm(sandbox, { recursive: true, force: true });
}
