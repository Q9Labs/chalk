import { strict as assert } from "node:assert";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stopFixturePages } from "./oauth-test-support.mjs";

/** Starts the recording engine proxy and the real Pages route graph, and returns the clients and probes the journey uses. */
export async function startHarness() {
  // A recording transport forwards every operation to the real API. Fault injection
  // exercises rate-limit handling only; no engine success response is fabricated.
  assert(process.env.DASHBOARD_TEST_API_ORIGIN, "Run through tests/dashboard/real-engine.sh");
  const apiOrigin = new URL(process.env.DASHBOARD_TEST_API_ORIGIN).origin;
  const requests = [];
  const engineReads = [];
  const engineRequests = [];
  const unsupportedBodies = [];

  const throttle = { path: undefined };
  const engine = createServer(async (request, response) => {
    requests.push(request.url);
    const observed = { method: request.method, path: request.url, at: Date.now(), status: undefined };
    engineRequests.push(observed);
    const read = request.method === "GET" ? observed : undefined;
    if (read) engineReads.push(read);
    let body = "";
    for await (const part of request) body += part;
    unsupportedBodies.push({ method: request.method, path: new URL(request.url, "http://localhost").pathname, body });
    if (throttle.path && request.url.startsWith(throttle.path)) {
      response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "3600" }).end(JSON.stringify({ error: { code: "request.rate_limited", message: "fixture transport throttle" } }));
      return;
    }
    try {
      const incoming = new URL(request.url, "http://localhost");
      const target = new URL(apiOrigin);
      target.pathname = incoming.pathname;
      target.search = incoming.search;
      assert.equal(target.origin, apiOrigin);
      const upstream = await fetch(target, { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : body, redirect: "manual" });
      const result = Buffer.from(await upstream.arrayBuffer());
      if (["GET", "POST"].includes(request.method) && new URL(request.url, "http://localhost").pathname.endsWith("/transcripts") && upstream.status < 300) {
        await writeFile(resolve(import.meta.dirname, "../../../../artifacts/dashboard-engine-transcripts.json"), result);
      }
      if (upstream.status >= 400) console.error("Engine failure:", request.method, new URL(request.url, "http://localhost").pathname, upstream.status, result.toString().slice(0, 2048));
      observed.status = upstream.status;
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers)).end(result);
    } catch {
      response.writeHead(503).end();
    }
  });
  async function tenantFor(person, provider = "google") {
    const response = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/tenants/by-external-id?external_id=${provider}:test:fixture_${person}`, { headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret" } });
    assert.equal(response.status, 200);
    return response.json();
  }
  function sql(statement) {
    return execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-Atqc", statement], { encoding: "utf8", env: { ...process.env, PGOPTIONS: "-c chalk.entry_writer=1" } }).trim();
  }
  // macOS tmpdir() sits behind the /var symlink; the fixture imports below are relative to the real path.
  const sandbox = await realpath(await mkdtemp(resolve(tmpdir(), "chalk-dashboard-pages-")));
  const web = resolve(import.meta.dirname, "../..");
  let pages;
  let watchdog;
  let pagesOutput = "";
  const deadline = setTimeout(
    () => {
      pages?.kill("SIGTERM");
      engine.close();
      process.exitCode = 1;
    },
    process.env.DASHBOARD_REFRESH_COST === "1" ? 300000 : 120000,
  );
  let origin;
  const stop = async () => {
    await stopFixturePages(pages, watchdog, deadline);
    await new Promise((done) => engine.close(done));
    await rm(sandbox, { recursive: true, force: true });
  };
  try {
    await mkdir(resolve(sandbox, "functions"));
    await mkdir(resolve(sandbox, "public"));
    await writeFile(resolve(sandbox, "public/index.html"), "fixture boundary");
    if (process.env.DASHBOARD_REFRESH_COST === "1") {
      await cp(resolve(web, "dist/client"), resolve(sandbox, "public"), { recursive: true, filter: (source) => !source.includes("/_worker.js") && !source.endsWith("/_routes.json") });
    }
    // Run the real named Pages route graph with a test-only composition root.
    for (const group of ["auth", "dashboard-api"]) {
      const names = group === "auth" ? ["start", "callback/google", "callback/apple", "session", "sign-out"] : ["home", "call", "call-invite", "call-status", "call-metadata", "home-status", "past-session", "transcript-text", "developer", "favicon"];
      await mkdir(resolve(sandbox, "functions", group));
      for (const name of names) {
        await mkdir(resolve(sandbox, "functions", group, name, ".."), { recursive: true });
        const original = await readFile(resolve(web, "functions", group, `${name}.ts`), "utf8");
        const entry = relative(resolve(sandbox, "functions", group, name, ".."), resolve(import.meta.dirname, "fixture-entry.ts"));
        await writeFile(resolve(sandbox, "functions", group, `${name}.ts`), original.replace(/(?:\.\.\/)+server\/production/, entry));
      }
    }
    await mkdir(resolve(sandbox, "functions/fixture"));
    const entry = relative(resolve(sandbox, "functions/fixture"), resolve(import.meta.dirname, "fixture-entry.ts"));
    await writeFile(resolve(sandbox, "functions/fixture/[[path]].ts"), `export { onRequest } from ${JSON.stringify(entry)};\n`);
    engine.listen(0, "127.0.0.1");
    await once(engine, "listening");
    for (const path of ["http://127.0.0.1:1/healthz?probe=absolute", "//127.0.0.1:1/healthz?probe=network"]) {
      const status = await new Promise((accept, reject) => {
        const request = httpRequest({ hostname: "127.0.0.1", port: engine.address().port, method: "GET", path }, (response) => {
          response.resume();
          response.once("end", () => accept(response.statusCode));
        });
        request.once("error", reject);
        request.end();
      });
      assert.equal(status, 200, "The recording transport must keep the configured API authority");
    }
    console.log("PASS: recording transport ignores absolute and network-path request authorities");
    const portProbe = createServer();
    await new Promise((ready, reject) => portProbe.once("error", reject).listen(0, "127.0.0.1", ready));
    const port = portProbe.address().port;
    await new Promise((resolve) => portProbe.close(resolve));
    origin = `http://127.0.0.1:${port}`;
    const bindings = {
      CHALK_ENVIRONMENT: "test",
      CHALK_API_ORIGIN: `http://127.0.0.1:${engine.address().port}`,
      DASHBOARD_ORIGIN: origin,
      GOOGLE_CLIENT_ID: "fixture-client",
      GOOGLE_CLIENT_SECRET: "fixture-google-not-a-secret",
      APPLE_SERVICES_ID: "fixture-apple",
      APPLE_TEAM_ID: "fixture-team",
      APPLE_KEY_ID: "fixture-key",
      APPLE_PRIVATE_KEY: "fixture-private-key",
      SESSION_SECRET: "fixture-only-cookie-password-32-characters",
      DASHBOARD_SERVICE_TOKEN: "fixture-dashboard-service-token-not-a-secret",
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
    watchdog = spawn(process.execPath, ["-e", `const owner=${process.pid},group=${pages.pid};setInterval(()=>{try{process.kill(owner,0)}catch{try{process.kill(-group,'SIGTERM')}catch{}process.exit()}},1000).unref();setTimeout(()=>{try{process.kill(-group,'SIGTERM')}catch{}},305000);`], {
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
  } catch (error) {
    await delay(200);
    console.error(pagesOutput.slice(-8000));
    await stop();
    throw error;
  }
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
        const exposed = (await response.clone().text()) + JSON.stringify([...response.headers]);
        for (const secret of ["fixture-dashboard-service-token-not-a-secret", "fixture-google-not-a-secret", "fixture-private-key", "fixture-local-system-not-a-secret", "fixture-only-cookie-password-32-characters"]) assert(!exposed.includes(secret), `Browser exposed ${secret}`);
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
    const loginCookie = client.cookies.get("local_chalk_login_google");
    const finished = await client.request(callback);
    assert.equal(finished.status, 303, `Callback ${await finished.text()}; engine paths ${JSON.stringify(requests)}`);
    assert.equal(finished.headers.get("location"), "/dashboard");
    assert.equal((await client.request(callback)).headers.get("location"), "/dashboard/sign-in?failed=google");
    client.cookies.set("local_chalk_login_google", loginCookie);
    assert.equal((await client.request(callback)).headers.get("location"), "/dashboard/sign-in?failed=google");
    const response = await client.request("/auth/session");
    assert.equal(response.status, 200);
    const dto = await response.json();
    assert.deepEqual(Object.keys(dto).sort(), ["csrfToken", "profile"]);
    assert(!JSON.stringify(dto).includes("fixture-dashboard-service-token-not-a-secret"));
    assert(!JSON.stringify(dto).includes("fixture-google-not-a-secret"));
    return dto;
  }
  async function post(client, path, value, token, extra = {}) {
    return client.request(path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token, ...extra }, body: JSON.stringify(value) });
  }
  return { origin, apiOrigin, engine, requests, engineReads, engineRequests, unsupportedBodies, throttle, tenantFor, sql, web, browser, signIn, post, stop, output: () => pagesOutput };
}
