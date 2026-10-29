import { stopFixturePages } from "./oauth-test-support.mjs";
import { strict as assert } from "node:assert";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile, realpath, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// A recording transport forwards every operation to the real API. Fault injection
// exercises rate-limit handling only; no engine success response is fabricated.
assert(process.env.DASHBOARD_TEST_API_ORIGIN, "Run through tests/dashboard/real-engine.sh");
const apiOrigin = new URL(process.env.DASHBOARD_TEST_API_ORIGIN).origin;
const requests = [];
const engineReads = [];
const engineRequests = [];
const unsupportedBodies = [];
const inviteCredential = (raw) => {
  const invite = new URL(raw);
  const code = invite.pathname.slice(1);
  return /^[a-z]+(?:-[a-z]+){2,3}$/.test(code) ? code : new URLSearchParams(invite.hash.slice(1)).get("spaceInviteToken");
};
let rateLimitPath;
const engine = createServer(async (request, response) => {
  requests.push(request.url);
  const observed = { method: request.method, path: request.url, at: Date.now(), status: undefined };
  engineRequests.push(observed);
  const read = request.method === "GET" ? observed : undefined;
  if (read) engineReads.push(read);
  let body = "";
  for await (const part of request) body += part;
  unsupportedBodies.push({ method: request.method, path: new URL(request.url, "http://localhost").pathname, body });
  if (rateLimitPath && request.url.startsWith(rateLimitPath)) {
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
try {
  await mkdir(resolve(sandbox, "functions"));
  await mkdir(resolve(sandbox, "public"));
  await writeFile(resolve(sandbox, "public/index.html"), "fixture boundary");
  if (process.env.DASHBOARD_REFRESH_COST === "1") {
    await cp(resolve(web, "dist/client"), resolve(sandbox, "public"), { recursive: true, filter: (source) => !source.includes("/_worker.js") && !source.endsWith("/_routes.json") });
  }
  // Run the real named Pages route graph with a test-only composition root.
  for (const group of ["auth", "dashboard-api"]) {
    const names = group === "auth" ? ["start", "callback/google", "callback/apple", "session", "sign-out"] : ["home", "call", "call-invite", "call-status", "call-metadata", "home-status", "past-session", "developer"];
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
  const origin = `http://127.0.0.1:${port}`;
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
  if (process.env.DASHBOARD_REFRESH_COST === "1") {
    const { refreshCost } = await import("./refresh-cost.mjs");
    const client = browser();
    const session = await signIn(client, "ada");
    await refreshCost({ client, session, post, origin, engineReads, engineRequests, tenantId: (await tenantFor("ada")).id, sql });
  } else {
    for (const provider of ["google", "apple"]) {
      for (const mismatch of provider === "google" ? ["state", "nonce", "challenge"] : ["state", "nonce"]) {
        const client = browser();
        const start = await client.request(`/auth/start?provider=${provider}`);
        const authorize = new URL(start.headers.get("location"));
        authorize.searchParams.set("person", "ada");
        authorize.searchParams.set(mismatch, "mismatch");
        const issued = await client.request(authorize);
        const callback = new URL(issued.headers.get("location"));
        const result = provider === "google" ? await client.request(callback) : await client.request(callback.pathname, { method: "POST", headers: { Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: callback.searchParams.toString() });
        assert.equal(result.headers.get("location"), `/dashboard/sign-in?failed=${provider}`);
        assert.equal((await client.request("/auth/session")).status, 401);
      }
    }
    const appleSuccess = browser();
    const appleStart = await appleSuccess.request("/auth/start?provider=apple");
    const appleAuthorize = new URL(appleStart.headers.get("location"));
    appleAuthorize.searchParams.set("person", "ada");
    const appleIssued = await appleSuccess.request(appleAuthorize);
    const appleCallback = new URL(appleIssued.headers.get("location"));
    assert.equal((await appleSuccess.request(appleCallback.pathname)).status, 405);
    const appleFinished = await appleSuccess.request(appleCallback.pathname, { method: "POST", headers: { Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: appleCallback.searchParams.toString() });
    assert.equal(appleFinished.headers.get("location"), "/dashboard");
    const appleSession = await (await appleSuccess.request("/auth/session")).json();
    assert.equal(appleSession.profile.name, "Ada Fixture");
    assert.equal((await post(appleSuccess, "/dashboard-api/home", { action: "create", name: "Untrusted" }, appleSession.csrfToken, { Origin: "https://appleid.apple.com" })).status, 403);
    assert.equal((await post(appleSuccess, "/auth/sign-out", {}, appleSession.csrfToken, { Origin: "https://appleid.apple.com" })).status, 403);
    const wrongApple = browser();
    const wrongStart = await wrongApple.request("/auth/start?provider=apple");
    const wrongAuthorize = new URL(wrongStart.headers.get("location"));
    wrongAuthorize.searchParams.set("person", "ada");
    const wrongIssued = new URL((await wrongApple.request(wrongAuthorize)).headers.get("location"));
    assert.equal((await wrongApple.request(wrongIssued.pathname, { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/x-www-form-urlencoded" }, body: wrongIssued.searchParams.toString() })).headers.get("location"), "/dashboard/sign-in?failed=apple");
    assert.equal((await wrongApple.request("/auth/session")).status, 401);
    console.log("PASS: Google/Apple state and nonce, Google PKCE mismatches rejected; Apple form_post restricted to callback");
    const ada = browser();
    let session = await signIn(ada, "ada");
    const firstTenant = (await tenantFor("ada")).id;
    assert.notEqual((await tenantFor("ada", "apple")).id, firstTenant, "Provider subjects must resolve to separate accounts");
    await signIn(ada, "ada");
    assert.equal((await tenantFor("ada")).id, firstTenant);
    assert.equal(sql("select count(*) from tenants where external_id = 'google:test:fixture_ada'"), "1");
    session = await (await ada.request("/auth/session")).json();
    const malik = browser();
    const other = await signIn(malik, "malik");
    const secondTenant = (await tenantFor("malik")).id;
    assert.notEqual(other.csrfToken, session.csrfToken);
    assert.equal((await ada.request("/auth/start?provider=google&returnTo=https%3A%2F%2Fevil.example")).status, 400);
    assert.equal((await ada.request("/auth/start?provider=google&returnTo=%2F%2Fevil.example")).status, 400);
    const count = requests.length;
    assert.equal((await post(ada, "/dashboard-api/home", {}, session.csrfToken, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post(ada, "/dashboard-api/home", {}, "")).status, 403);
    assert.equal((await post(ada, "/dashboard-api/home", {}, other.csrfToken)).status, 403);
    assert.equal(requests.length, count);
    const apple = browser();
    await apple.request("/auth/start?provider=apple");
    const failedApple = await apple.request("/auth/callback/apple", { method: "POST", headers: { Origin: "https://appleid.apple.com", "Content-Type": "application/x-www-form-urlencoded" }, body: "error=access_denied" });
    assert.equal(failedApple.status, 303);
    assert.equal(failedApple.headers.get("location"), "/dashboard/sign-in?failed=apple");
    assert(failedApple.headers.get("X-Request-ID"));
    const unnamed = await post(ada, "/dashboard-api/home", { action: "create-call", admission: "anyone", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(unnamed.status, 200, await unnamed.clone().text());
    assert.equal((await unnamed.json()).call.name, "New call");
    const unicode = await post(ada, "/dashboard-api/home", { action: "create-call", name: "اجتماع Réunion", admission: "anyone", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(unicode.status, 200, await unicode.clone().text());
    const unicodeId = (await unicode.json()).call.id;
    const rawInvite = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/tenants/${firstTenant}/spaces/${unicodeId}/public-invite`, { headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret" } });
    assert.equal(rawInvite.status, 200, await rawInvite.clone().text());
    const unicodeLink = (await rawInvite.json()).canonical_url;
    const unicodeHome = await ada.request("/dashboard-api/home");
    assert.equal(unicodeHome.status, 200, await unicodeHome.clone().text());
    assert.equal((await unicodeHome.json()).calls.find((call) => call.id === unicodeId).inviteUrl, null);
    const unicodeCall = await ada.request(`/dashboard-api/call?spaceId=${unicodeId}`);
    assert.equal(unicodeCall.status, 200, await unicodeCall.clone().text());
    assert.equal((await unicodeCall.json()).inviteUrl, unicodeLink);
    // Remove the regression fixture from later Home pagination assertions.
    assert.equal((await post(ada, "/dashboard-api/home", { action: "archive-call", spaceId: unicodeId }, session.csrfToken)).status, 200);
    const malikTenant = secondTenant;
    const created = await post(ada, "/dashboard-api/home", { action: "create-call", name: "Original", admission: "anyone", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(created.status, 200, await created.clone().text());
    const spaceId = (await created.json()).call.id;
    for (const action of [
      { action: "rename-call", spaceId, name: "Renamed" },
      { action: "set-admission", spaceId, admission: "knock" },
    ]) {
      const response = await post(ada, "/dashboard-api/home", action, session.csrfToken);
      assert.equal(response.status, 200, await response.clone().text());
    }
    const ownCall = await ada.request(`/dashboard-api/call?spaceId=${spaceId}`);
    assert.equal(ownCall.status, 200, await ownCall.clone().text());
    const storedSpace = JSON.parse(sql(`select row_to_json(s) from spaces s where id='${spaceId}'`));
    assert.equal(storedSpace.name, "Renamed");
    assert.equal(storedSpace.admission_policy.mode, "knock");
    assert.equal(storedSpace.default_episode_duration_seconds, 3600);
    let sourceEpisodeId;
    // Use separate Spaces so the historical attendance fixtures stay independent.
    for (const admission of ["anyone", "knock"]) {
      const createdCall = await post(ada, "/dashboard-api/home", { action: "create-call", name: `Owner ${admission}`, admission, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
      assert.equal(createdCall.status, 200, await createdCall.clone().text());
      const ownerSpaceId = (await createdCall.json()).call.id;
      const join = { action: "join", spaceId: ownerSpaceId, idempotencyKey: crypto.randomUUID() };
      const joined = await post(ada, "/dashboard-api/call", join, session.csrfToken);
      assert.equal(joined.status, 200, await joined.clone().text());
      const grant = (await joined.json()).access;
      sourceEpisodeId = grant.subject.episode_id;
      assert(grant.sync.token && grant.media.token);
      // Exercise Sync's real UUID decoder, not a second copy of its regex.
      assert.equal(execFileSync("elixir", ["-r", resolve(import.meta.dirname, "../../../../apps/sync/lib/chalk_sync/uuid.ex"), "-e", "[id] = System.argv(); ChalkSync.UUID.dump!(id); IO.write(id)", "--", grant.subject.participant_id], { encoding: "utf8" }), grant.subject.participant_id);
      assert.equal(grant.subject.tenant_id, firstTenant);
      const replay = await post(ada, "/dashboard-api/call", join, session.csrfToken);
      assert.equal(replay.status, 200, await replay.clone().text());
      assert.equal((await replay.json()).access.subject.participant_id, grant.subject.participant_id);
      assert.equal(sql(`select count(*) from participants where episode_id='${grant.subject.episode_id}'`), "1");
      sql(`update participants set status='active', joined_at=now(), first_joined_at=now() where id='${grant.subject.participant_id}';
    insert into sync_episode_control(tenant_id,space_id,episode_id,folded_state,state_schema_version,state_digest,snapshot_bytes)
    values('${firstTenant}','${ownerSpaceId}','${grant.subject.episode_id}','{"participants":[{"participant_id":"${grant.subject.participant_id}","display_name":"Owner"}]}',1,decode(repeat('00',32),'hex'),2)
    on conflict(tenant_id,space_id,episode_id) do update set folded_state=jsonb_set(sync_episode_control.folded_state,'{participants}',excluded.folded_state->'participants')`);
      const liveOffset = requests.length;
      const liveCall = await ada.request(`/dashboard-api/call?spaceId=${ownerSpaceId}`);
      assert.equal(liveCall.status, 200, await liveCall.clone().text());
      const liveDTO = await liveCall.json();
      assert(requests.length - liveOffset <= 41, "Call enrichment stays within its request bound");
      assert.equal(liveDTO.live.count, 1);
      assert.equal(liveDTO.live.participants[0].id, grant.subject.participant_id);
      assert.equal(liveDTO.episodes[0].participantCount, 1);
      const ownPast = await ada.request(`/dashboard-api/past-session?spaceId=${ownerSpaceId}&episodeId=${grant.subject.episode_id}`);
      assert.equal(ownPast.status, 200, await ownPast.clone().text());
      const ownerAttendance = (await ownPast.json()).attendance.participants[0];
      assert.equal(ownerAttendance.isYou, true);
      assert.equal(ownerAttendance.kind, "user");
      assert.equal(ownerAttendance.externalId, null);
      sql(
        `update participants set status='joining', joined_at=null, first_joined_at=null where id='${grant.subject.participant_id}'; update sync_episode_control set folded_state=jsonb_set(folded_state,'{participants}','[]'::jsonb) where tenant_id='${firstTenant}' and episode_id='${grant.subject.episode_id}'`,
      );
      const refreshedAccess = await post(ada, "/dashboard-api/call", { action: "refresh-access", spaceId: ownerSpaceId }, session.csrfToken);
      // Already-loaded bundles without a join key retain their signed single-seat path.
      // An admitted joining seat can refresh before Sync confirms entry.
      assert.equal(refreshedAccess.status, 200, await refreshedAccess.clone().text());
      const refreshedGrant = (await refreshedAccess.json()).access;
      assert.equal(refreshedGrant.subject.participant_id, grant.subject.participant_id);
      // Tabs in one signed-in browser share cookies, but own different seats.
      // Production returned 403 media_token.subject_mismatch here, surfaced as 502.
      const otherJoin = { ...join, idempotencyKey: crypto.randomUUID() };
      const otherJoined = await post(ada, "/dashboard-api/call", otherJoin, session.csrfToken);
      assert.equal(otherJoined.status, 200, await otherJoined.clone().text());
      const otherGrant = (await otherJoined.json()).access;
      assert.notEqual(otherGrant.subject.participant_id, grant.subject.participant_id);
      for (const [initial, joinKey] of [
        [refreshedGrant, join.idempotencyKey],
        [otherGrant, otherJoin.idempotencyKey],
      ]) {
        let access = initial;
        for (const replaceMedia of [false, true]) {
          const refreshed = await post(ada, "/dashboard-api/call", { action: "refresh-access", spaceId: ownerSpaceId, joinKey, ...(!replaceMedia ? { currentMediaToken: access.media.token } : {}) }, session.csrfToken);
          assert.equal(refreshed.status, 200, `A sibling tab must not replace this tab's owner seat: ${await refreshed.clone().text()}`);
          access = (await refreshed.json()).access;
          assert.equal(access.subject.participant_id, initial.subject.participant_id);
        }
      }
      const unknownSeat = await post(ada, "/dashboard-api/call", { action: "refresh-access", spaceId: ownerSpaceId, joinKey: crypto.randomUUID() }, session.csrfToken);
      assert.equal(unknownSeat.status, 401, "A join key without its sealed seat cookie grants no authority");
      if (admission === "knock") {
        const guest = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/tenants/${firstTenant}/spaces/${ownerSpaceId}/episodes/${grant.subject.episode_id}/participants`, {
          method: "POST",
          headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ name: "Guest", role: "observer", participant_id: crypto.randomUUID() }),
        });
        assert.equal(guest.status, 201, await guest.clone().text());
        const waiting = await guest.json();
        assert(waiting.admission_request);
        assert(!waiting.access);
      }
      // A deliberate rejoin after a leave gets a fresh seat, not the replay seat.
      // Sync is not running in this harness; seed its completed leave state.
      sql(`update participants set status='left', left_at=now() where id='${grant.subject.participant_id}'`);
      const rejoin = await post(ada, "/dashboard-api/call", { ...join, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
      assert.equal(rejoin.status, 200, await rejoin.clone().text());
      assert.notEqual((await rejoin.json()).access.subject.participant_id, grant.subject.participant_id);
      const end = await post(ada, "/dashboard-api/call", { action: "end-for-everyone", spaceId: ownerSpaceId, episodeId: grant.subject.episode_id, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
      assert.equal(end.status, 200, await end.clone().text());
      assert.equal(sql(`select status from episodes where id='${grant.subject.episode_id}'`), "ending");
    }
    console.log("PASS: owner open/knock grants, shared-cookie tab refresh/replacement isolation, same-key replay, new-key rejoin, end-for-everyone accepted, guest knock still waits");
    // Completed decisions are history, not new knocks the owner can answer again.
    const knockingCall = await post(ada, "/dashboard-api/home", { action: "create-call", admission: "knock", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(knockingCall.status, 200);
    const knockingSpace = (await knockingCall.json()).call.id;
    const invitation = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
    const inviteToken = inviteCredential((await invitation.json()).inviteUrl);
    {
      const arrival = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/public/space-invite-arrivals`, {
        method: "POST",
        headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ space_invite_token: inviteToken, display_name: "Knocking guest" }),
      });
      assert.equal(arrival.status, 201, await arrival.clone().text());
      const waitingCall = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
      const pending = (await waitingCall.json()).knocks;
      assert.equal(pending.length, 1);
      assert.equal(pending[0].state, "pending");
      for (let index = 0; index < 50; index++) {
        const stale = await fetch(`${apiOrigin}/v1/public/space-invite-arrivals`, {
          method: "POST",
          headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ space_invite_token: inviteToken, display_name: `Expired guest ${index}` }),
        });
        assert.equal(stale.status, 201, await stale.clone().text());
      }
      sql(`update space_public_admission_requests set requested_at=now()-interval '10 minutes', expires_at=now()-interval '1 second' where space_id='${knockingSpace}' and request_handle<>'${pending[0].handle}'`);
      const actionable = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
      assert.deepEqual(
        (await actionable.json()).knocks.map((knock) => knock.handle),
        [pending[0].handle],
        "Expired knocks cannot fill the engine list limit and hide a valid request",
      );
      sql(`update space_public_admission_requests set expires_at=now()-interval '1 second' where space_id='${knockingSpace}'`);
      const raw = await fetch(`${apiOrigin}/v1/tenants/${firstTenant}/spaces/${knockingSpace}/public-admission-requests?state=pending`, { headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret" } });
      assert.equal(raw.status, 200);
      assert.equal((await raw.json()).requests.length, 0, "Engine excludes expired pending knocks before its list limit");
      const expired = await ada.request(`/dashboard-api/call?spaceId=${knockingSpace}`);
      assert.deepEqual((await expired.json()).knocks, [], "Dashboard filters expired knocks at the server boundary");
      sql(`update space_public_admission_requests set expires_at=now()+interval '5 minutes' where request_handle='${pending[0].handle}'`);
      const decisionKey = crypto.randomUUID();
      const decided = await post(ada, "/dashboard-api/call", { action: "deny-knock", spaceId: knockingSpace, requestHandle: pending[0].handle, idempotencyKey: decisionKey }, session.csrfToken);
      assert.equal(decided.status, 200, await decided.clone().text());
      const accepted = await ada.request(`/dashboard-api/call-status?spaceId=${knockingSpace}`);
      const acceptedKnocks = (await accepted.json()).knocks;
      assert.equal(acceptedKnocks[0].decisionState, "in_flight", "Accepted denial stays busy until Sync commits");
      // This API-only harness has no Sync consumer. Seed its terminal result;
      // the real-Sync retry and two-browser proofs exercise that commit itself.
      sql(`update sync_admission_requests set status='denied', completed_at=now() where admission_request_id='${pending[0].handle}'`);
      const settled = await ada.request(`/dashboard-api/call-status?spaceId=${knockingSpace}`);
      assert.deepEqual((await settled.json()).knocks, [], "Sync denial removes the request from the shared status projection");
    }
    console.log("PASS: real engine excludes expired knocks before paging; dashboard keeps accepted decisions busy and hides Sync-denied knocks");

    const keyResponse = await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Test", scopes: ["spaces:read"], expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(keyResponse.status, 200, await keyResponse.clone().text());
    const keyId = (await keyResponse.json()).id;
    const yearExpiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const yearKey = await post(ada, "/dashboard-api/developer", { action: "create-key", name: "One year", scopes: ["spaces:read"], expiresAt: yearExpiry, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(yearKey.status, 200, await yearKey.clone().text());
    const tooLate = await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Too late", scopes: ["spaces:read"], expiresAt: new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString(), idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(tooLate.status, 400, await tooLate.clone().text());
    assert.deepEqual(await tooLate.json(), { error: { code: "api_key_invalid_expiry" } });
    console.log("PASS: real dashboard and API accept one-year keys and preserve expiry validation errors");
    assert.equal((await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Escalation", scopes: ["tenants:write"], expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }, session.csrfToken)).status, 400);
    const hookResponse = await post(ada, "/dashboard-api/developer", { action: "create-webhook", name: "Test", url: "https://example.com/hook?token=fixture-webhook-url-credential", enabled: true, eventTypes: ["episode.ended"], idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(hookResponse.status, 200, await hookResponse.clone().text());
    const hook = (await hookResponse.json()).webhook;
    const webhookId = hook.id;
    const targetBefore = sql(`select current_target_revision from webhook_endpoints where id='${webhookId}'`);
    const urlBefore = sql(`select encode(url_ciphertext,'hex') from webhook_endpoint_revisions where endpoint_id='${webhookId}' and revision=${targetBefore}`);
    const updatedHook = await post(ada, "/dashboard-api/developer", { action: "update-webhook", webhookId, revision: hook.revision, enabled: false, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(updatedHook.status, 200, await updatedHook.clone().text());
    const patch = unsupportedBodies.findLast((r) => r.method === "PATCH" && r.path.endsWith(`/webhook-endpoints/${webhookId}`));
    assert.deepEqual(JSON.parse(patch.body), { enabled: false });
    assert.equal(sql(`select enabled from webhook_endpoints where id='${webhookId}'`), "f");
    const targetAfter = sql(`select current_target_revision from webhook_endpoints where id='${webhookId}'`);
    assert.equal(sql(`select encode(url_ciphertext,'hex') from webhook_endpoint_revisions where endpoint_id='${webhookId}' and revision=${targetAfter}`), urlBefore);
    console.log("PASS: partial webhook update omits URL and preserves the actual encrypted destination");
    const ownDeliveries = await post(ada, "/dashboard-api/developer", { action: "webhook-deliveries", webhookId }, session.csrfToken);
    assert.equal(ownDeliveries.status, 200, await ownDeliveries.clone().text());
    assert.deepEqual((await ownDeliveries.json()).deliveries, []);
    const enabledHook = await post(ada, "/dashboard-api/developer", { action: "update-webhook", webhookId, revision: (await updatedHook.json()).webhook.revision, enabled: true, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(enabledHook.status, 200, await enabledHook.clone().text());
    const testDelivery = await post(ada, "/dashboard-api/developer", { action: "test-webhook", webhookId, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(testDelivery.status, 200, await testDelivery.clone().text());
    const testDeliveryId = (await testDelivery.json()).deliveryId;
    // The API's dispatcher may already hold this delivery's lease and its started attempt row.
    // Taking the lease away makes the dispatcher's lease-guarded completion a no-op.
    sql(`update webhook_deliveries set attempt_count=1, state='succeeded', next_attempt_at=null, terminal_at=now(), lease_token=null, lease_owner=null, lease_expires_at=null where id='${testDeliveryId}';
  insert into webhook_delivery_attempts(id,tenant_id,delivery_id,attempt_number,started_at,finished_at,latency_milliseconds,outcome,http_status) values(gen_random_uuid(),'${firstTenant}','${testDeliveryId}',1,now(),now(),1,'succeeded',204)
  on conflict (tenant_id,delivery_id,attempt_number) do update set finished_at=excluded.finished_at, latency_milliseconds=excluded.latency_milliseconds, outcome=excluded.outcome, http_status=excluded.http_status;
  update api_keys set last_used_at='2026-10-18T00:00:00Z' where id='${keyId}'`);
    const developer = await ada.request("/dashboard-api/developer");
    assert.equal(developer.status, 200, await developer.clone().text());
    const developerDTO = await developer.json();
    assert.equal(developerDTO.tenantId, firstTenant);
    assert.equal(developerDTO.keys.find((key) => key.id === keyId).lastUsedAt, "2026-10-18T00:00:00Z");
    const lastDelivery = developerDTO.webhooks.find((hook) => hook.id === webhookId).lastDelivery;
    assert.equal(lastDelivery.id, testDeliveryId);
    assert(lastDelivery.eventType);
    assert.equal(lastDelivery.status, 204);
    assert.equal(lastDelivery.attempts, 1);
    const deliveryRows = await post(ada, "/dashboard-api/developer", { action: "webhook-deliveries", webhookId }, session.csrfToken);
    assert.equal(deliveryRows.status, 200, await deliveryRows.clone().text());
    assert.deepEqual(
      (await deliveryRows.json()).deliveries.find((d) => d.id === testDeliveryId),
      lastDelivery,
    );
    const foreign = { spaceId, episodeId: crypto.randomUUID(), recordingId: crypto.randomUUID(), transcriptId: crypto.randomUUID(), keyId, webhookId, deliveryId: crypto.randomUUID() };
    // Provider artifacts are seeded, not mocked. Every read/authorization uses the
    // production HTTP server and PostgreSQL repositories; no vendor is contacted.
    sql(`insert into episodes(id,tenant_id,space_id,status,started_at,ended_at,config_snapshot) values('${foreign.episodeId}','${firstTenant}','${spaceId}','ended',now()-interval '1 hour',now(),(select config_snapshot from episodes where id='${sourceEpisodeId}'));
  insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values('${foreign.recordingId}','${firstTenant}','${spaceId}','${foreign.episodeId}','failed','r2');
  insert into transcriptions(id,tenant_id,space_id,episode_id,recording_id,status,languages) values('${foreign.transcriptId}','${firstTenant}','${spaceId}','${foreign.episodeId}','${foreign.recordingId}','terminal_failure','{en}');
  insert into participants(id,tenant_id,space_id,episode_id,name,capabilities,generation,status,role,joined_at,first_joined_at) select gen_random_uuid(),'${firstTenant}','${spaceId}','${foreign.episodeId}','Same name',array['subscribe'],1,'active','owner',now()-interval '1 hour',now()-interval '1 hour' from generate_series(1,2);`);
    const past = await ada.request(`/dashboard-api/past-session?spaceId=${spaceId}&episodeId=${foreign.episodeId}`);
    assert.equal(past.status, 200, await past.clone().text());
    const pastDTO = await past.json();
    assert.equal(pastDTO.attendance.participants.length, 2);
    assert(pastDTO.attendance.participants.every((p) => p.name === "Same name" && p.kind === "user" && p.externalId === null && p.isYou === false && p.firstJoinedAt && Date.parse(p.lastLeftAt) === Date.parse(pastDTO.episode.endedAt)));
    assert.equal(pastDTO.recordings[0].id, foreign.recordingId);
    const ownTranscripts = await post(ada, "/dashboard-api/past-session", { action: "transcripts", spaceId, episodeId: foreign.episodeId, recordingId: foreign.recordingId }, session.csrfToken);
    assert.equal(ownTranscripts.status, 200, await ownTranscripts.clone().text());
    assert.equal((await ownTranscripts.json()).transcripts[0].id, foreign.transcriptId);
    const enrichedCall = await ada.request(`/dashboard-api/call?spaceId=${spaceId}`);
    assert.equal(enrichedCall.status, 200, await enrichedCall.clone().text());
    const historical = (await enrichedCall.json()).episodes.find((episode) => episode.id === foreign.episodeId);
    assert.equal(historical.participantCount, 2);
    assert.equal(historical.recordings[0].status, "failed");
    assert.equal(historical.recordings[0].transcripts[0].status, "terminal_failure");
    // Copy/share uses the session's tenant and only reads the invite, even when history fails.
    rateLimitPath = `/v1/tenants/${firstTenant}/spaces/${spaceId}/episodes`;
    try {
      assert.equal((await ada.request(`/dashboard-api/call?spaceId=${spaceId}`)).status, 429);
      const offset = engineRequests.length;
      const invite = await ada.request(`/dashboard-api/call-invite?spaceId=${spaceId}`);
      assert.equal(invite.status, 200, await invite.clone().text());
      assert.deepEqual(Object.keys(await invite.json()), ["inviteUrl"]);
      assert.deepEqual(
        engineRequests.slice(offset).map(({ method, path }) => [method, path.split("?")[0]]),
        [["GET", `/v1/tenants/${firstTenant}/spaces/${spaceId}/public-invite`]],
      );
      assert.equal((await ada.request("/dashboard-api/call-invite?spaceId=invalid")).status, 400);
      assert.equal((await ada.request(`/dashboard-api/call-invite?spaceId=${spaceId}&cursor=unexpected`)).status, 400);
      console.log("PASS: invite-only read uses one engine GET with the cached session tenant despite failing history; rejects invalid IDs and extra fields");
    } finally {
      rateLimitPath = undefined;
    }
    for (const [kind, id] of [
      ["recording", foreign.recordingId],
      ["transcript", foreign.transcriptId],
    ]) {
      const offset = engineReads.length;
      const metadata = await ada.request(`/dashboard-api/call-metadata?kind=${kind}&spaceId=${spaceId}&id=${id}`);
      assert.equal(metadata.status, 200, await metadata.clone().text());
      const result = await metadata.json();
      assert.equal(result.kind, kind);
      assert.equal(result[kind].id, id);
      if (kind === "recording") {
        assert.equal(result.recording.sourceStatus, "failed");
        assert.equal(result.recording.exportStatus, "unavailable");
        assert.equal(result.recording.transcriptionStatus, "failed");
        assert.equal(result.recording.failureMessage, "The recording capture did not complete.");
        assert.equal(result.recording.transcripts[0].id, foreign.transcriptId);
      }
      assert.equal(engineReads.slice(offset).filter((read) => read.path.startsWith(`/v1/tenants/${firstTenant}/`)).length, kind === "recording" ? 2 : 1, "Recording discovery costs two tenant reads; transcript refresh costs one");
    }
    const retry = await post(ada, "/dashboard-api/past-session", { action: "create-transcript", languages: ["en"], spaceId, episodeId: foreign.episodeId, recordingId: foreign.recordingId, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(retry.status, 409, await retry.clone().text());
    assert(unsupportedBodies.some((r) => r.method === "POST" && r.path.endsWith(`/recordings/${foreign.recordingId}/transcripts`)));
    const documentFixture = JSON.stringify({
      schemaVersion: "transcript.v1",
      jobId: crypto.randomUUID(),
      episodeId: foreign.episodeId,
      provider: "cloudflare",
      model: "fixture",
      versionContract: "v1",
      attempt: 0,
      measuredAudioMs: 1000,
      cues: [
        {
          startMs: 0,
          endMs: 1000,
          identity: { kind: "participant", participantRef: "speaker-1", participantGeneration: 1, trackId: "audio", trackEpoch: "one" },
          trackClass: "microphone",
          displayNameSnapshot: "Speaker name",
          text: "Hello",
          overlap: false,
          provider: "cloudflare",
          model: "fixture",
          versionContract: "v1",
          attempt: 0,
        },
      ],
    });
    await writeFile(resolve(import.meta.dirname, "../../../../artifacts/dashboard-transcript.json"), documentFixture);
    sql(`update transcriptions set status='complete', artifact_key='transcript.json', artifact_size=${Buffer.byteLength(documentFixture)}, artifact_content_type='application/json' where id='${foreign.transcriptId}'`);
    const documentResponse = await post(ada, "/dashboard-api/past-session", { action: "transcript-document", spaceId, episodeId: foreign.episodeId, transcriptId: foreign.transcriptId }, session.csrfToken);
    assert.equal(documentResponse.status, 200, await documentResponse.clone().text());
    assert.deepEqual((await documentResponse.json()).cues, [{ startMs: 0, endMs: 1000, text: "Hello", speaker: { name: "Speaker name", participantRef: "speaker-1" } }]);
    const freshRecordingId = crypto.randomUUID();
    sql(`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values('${freshRecordingId}','${firstTenant}','${spaceId}','${foreign.episodeId}','failed','r2');
  insert into recording_transcription_sources(recording_id,tenant_id,manifest_key,manifest_sha256,manifest_size,manifest_content_type,schema_version,committed_at,generation,commit_digest,presentation_sha256,status,expires_at)
  values('${freshRecordingId}','${firstTenant}','transcription/source/${freshRecordingId}/manifest.json',decode(repeat('00',32),'hex'),1,'application/json',1,now(),1,decode(repeat('00',32),'hex'),decode(repeat('00',32),'hex'),'ready',now()+interval '1 hour');
  insert into recording_transcription_source_chunks(id,recording_id,tenant_id,chunk_index,generation,start_ms,end_ms,source_start_ms,source_end_ms,participant_ref,participant_generation,track_id,track_epoch,identity_kind,track_class,display_name_snapshot,overlap,storage_key,checksum,size,content_type)
  values(gen_random_uuid(),'${freshRecordingId}','${firstTenant}',0,1,0,1000,0,1000,'participant-1',1,'track-1','1','participant','microphone','Speaker',false,'transcription/source/${freshRecordingId}/chunk-0.flac',decode(repeat('00',32),'hex'),1,'audio/flac')`);
    const transcriptRequest = { action: "create-transcript", languages: ["en"], spaceId, episodeId: foreign.episodeId, recordingId: freshRecordingId, idempotencyKey: crypto.randomUUID() };
    const beforeMissingLanguages = unsupportedBodies.filter((request) => request.method === "POST" && request.path.endsWith(`/recordings/${freshRecordingId}/transcripts`)).length;
    const { languages: requestedLanguages, ...withoutLanguages } = transcriptRequest;
    assert.deepEqual(requestedLanguages, ["en"]);
    assert.equal((await post(ada, "/dashboard-api/past-session", withoutLanguages, session.csrfToken)).status, 400);
    assert.equal(unsupportedBodies.filter((request) => request.method === "POST" && request.path.endsWith(`/recordings/${freshRecordingId}/transcripts`)).length, beforeMissingLanguages);
    const requestedTranscript = await post(ada, "/dashboard-api/past-session", transcriptRequest, session.csrfToken);
    assert.equal(requestedTranscript.status, 200, await requestedTranscript.clone().text());
    const transcriptId = (await requestedTranscript.json()).transcript.id;
    const replayedTranscript = await post(ada, "/dashboard-api/past-session", transcriptRequest, session.csrfToken);
    assert.equal(replayedTranscript.status, 200, await replayedTranscript.clone().text());
    assert.equal((await replayedTranscript.json()).transcript.id, transcriptId);
    for (const path of [
      `/dashboard-api/call?spaceId=${spaceId}`,
      `/dashboard-api/call-metadata?kind=recording&spaceId=${spaceId}&id=${foreign.recordingId}`,
      `/dashboard-api/call-metadata?kind=transcript&spaceId=${spaceId}&id=${foreign.transcriptId}`,
      `/dashboard-api/home-status?spaceIds=${spaceId}`,
      `/dashboard-api/past-session?spaceId=${spaceId}&episodeId=${foreign.episodeId}`,
    ])
      assert.equal((await malik.request(path)).status, 404);
    const foreignStatus = await malik.request(`/dashboard-api/call-status?spaceId=${spaceId}`);
    assert.equal(foreignStatus.status, 200);
    assert.deepEqual(await foreignStatus.json(), { latestEpisodeId: null, episode: null, knocks: [] });
    const mutations = [
      ["call", { action: "rename-call", spaceId: foreign.spaceId, name: "Renamed" }],
      ["call", { action: "set-admission", spaceId: foreign.spaceId, admission: "knock" }],
      ["home", { action: "rename-call", spaceId: foreign.spaceId, name: "Renamed" }],
      ["home", { action: "set-admission", spaceId: foreign.spaceId, admission: "knock" }],
      ["home", { action: "archive-call", spaceId: foreign.spaceId }],
      ["home", { action: "restore-call", spaceId: foreign.spaceId }],
      ["call", { action: "join", spaceId: foreign.spaceId, idempotencyKey: crypto.randomUUID() }],
      ["call", { action: "rotate-link", spaceId: foreign.spaceId, idempotencyKey: crypto.randomUUID() }],
      ["call", { action: "end-for-everyone", spaceId: foreign.spaceId, episodeId: foreign.episodeId, idempotencyKey: crypto.randomUUID() }],
      ["call", { action: "approve-knock", spaceId: foreign.spaceId, requestHandle: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }],
      ["call", { action: "deny-knock", spaceId: foreign.spaceId, requestHandle: crypto.randomUUID(), idempotencyKey: crypto.randomUUID() }],
      ...["recording-url", "export-recording", "transcripts", "create-transcript"].map((action) => [
        "past-session",
        {
          action,
          spaceId: foreign.spaceId,
          episodeId: foreign.episodeId,
          recordingId: foreign.recordingId,
          ...(action === "create-transcript" ? { languages: ["en"] } : {}),
          ...(action === "recording-url" ? { download: true } : action === "export-recording" || action === "create-transcript" ? { idempotencyKey: crypto.randomUUID() } : {}),
        },
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
      assert.equal(response.status, 404, `${action.action}: ${await response.clone().text()}`);
      const attempted = requests.slice(offset).filter((path) => path.startsWith("/v1/tenants/") && !path.startsWith("/v1/tenants/by-external-id"));
      assert(attempted.length > 0, `${action.action} did not exercise an engine path`);
      assert(
        attempted.every((path) => path.startsWith(`/v1/tenants/${malikTenant}/`)),
        `${action.action} escaped the authenticated Tenant`,
      );
      assert(!attempted.some((path) => path.includes(firstTenant)));
    }
    assert.equal((await post(malik, "/dashboard-api/call", { action: "refresh-access", spaceId: foreign.spaceId, joinKey: crypto.randomUUID() }, other.csrfToken)).status, 401);
    assert.equal((await post(malik, "/dashboard-api/call", { action: "refresh-access", spaceId: foreign.spaceId, joinKey: crypto.randomUUID(), participantId: foreign.recordingId }, other.csrfToken)).status, 400);
    assert.equal((await post(malik, "/dashboard-api/home", { action: "archive-call", spaceId: foreign.spaceId, tenantId: firstTenant }, other.csrfToken)).status, 400);

    assert.equal((await tenantFor("malik")).recording_render_mode, "on_demand");
    const automatic = await post(malik, "/dashboard-api/developer", { action: "set-recording-render-mode", mode: "automatic" }, other.csrfToken);
    assert.equal(automatic.status, 200, await automatic.clone().text());
    assert.deepEqual(await automatic.json(), { recordingRenderMode: "automatic" });
    assert.deepEqual(unsupportedBodies.at(-1), { method: "PATCH", path: `/v1/tenants/${secondTenant}`, body: JSON.stringify({ recording_render_mode: "automatic" }) });
    assert.equal((await tenantFor("malik")).recording_render_mode, "automatic");
    assert.equal((await tenantFor("ada")).recording_render_mode, "on_demand", "Saving one account must not change another account");
    const developerSettings = await malik.request("/dashboard-api/developer");
    assert.equal(developerSettings.status, 200);
    const otherDeveloperDTO = await developerSettings.json();
    assert.equal(otherDeveloperDTO.recordingRenderMode, "automatic");
    assert.equal(otherDeveloperDTO.tenantId, secondTenant);
    for (const action of [
      { action: "set-recording-render-mode", mode: "always" },
      { action: "set-recording-render-mode", mode: "automatic", tenantId: firstTenant },
    ]) {
      assert.equal((await post(malik, "/dashboard-api/developer", action, other.csrfToken)).status, 400);
    }
    assert.equal((await post(malik, "/dashboard-api/developer", { action: "set-recording-render-mode", mode: "on_demand" }, other.csrfToken)).status, 200);
    assert.equal((await tenantFor("malik")).recording_render_mode, "on_demand");
    console.log("PASS: dashboard recording mode persists through the real API and stays inside the signed-in Tenant");

    assert.equal((await post(malik, "/dashboard-api/developer", { action: "set-allowed-websites", origins: ["https://example.test", "http://localhost:3000"] }, other.csrfToken)).status, 200);
    assert.deepEqual(unsupportedBodies.at(-1), { method: "PATCH", path: `/v1/tenants/${secondTenant}`, body: JSON.stringify({ cors_allowed_origins: ["https://chalkmeet.com", "https://example.test", "http://localhost:3000", origin] }) });
    const websites = await post(malik, "/dashboard-api/developer", { action: "allowed-websites" }, other.csrfToken);
    assert.equal(websites.status, 200);
    const expectedWebsites = ["https://chalkmeet.com", "https://example.test", "http://localhost:3000", origin].toSorted();
    assert.deepEqual((await websites.json()).allowedWebsites.toSorted(), expectedWebsites);
    assert.deepEqual((await tenantFor("malik")).cors_allowed_origins.toSorted(), expectedWebsites);
    const writesBeforeLimit = unsupportedBodies.filter((entry) => entry.method === "PATCH").length;
    assert.equal((await post(malik, "/dashboard-api/developer", { action: "set-allowed-websites", origins: Array.from({ length: 31 }, (_, i) => `https://site-${i}.example.test`) }, other.csrfToken)).status, 400);
    assert.equal(unsupportedBodies.filter((entry) => entry.method === "PATCH").length, writesBeforeLimit, "The 32-origin limit includes both dashboard origins");
    assert.deepEqual((await tenantFor("malik")).cors_allowed_origins.toSorted(), expectedWebsites);
    const homeOffset = requests.length;
    const home = await ada.request("/dashboard-api/home");
    assert.equal(home.status, 200, await home.clone().text());
    const homeDTO = await home.json();
    assert(requests.length - homeOffset <= 18, "Home enrichment stays within its request bound");
    assert.equal(homeDTO.live.find((row) => row.spaceId === spaceId).episode, null);
    const homeCall = homeDTO.calls.find((row) => row.id === spaceId);
    assert.equal(homeCall.inviteUrl, null);
    assert(homeCall.slug && homeCall.lastActiveAt);
    assert(!requests.slice(homeOffset).some((path) => new URL(path, apiOrigin).pathname.endsWith("/public-invite")), "Home never mints per-space invites in the engine write bucket");
    assert.equal(homeCall.recentPeople.length, 2);
    console.log("PASS: bounded enriched Home/Call/Developer DTOs, live people, authenticated isYou, optional call name, provider-safe callback redirects, and transcript request ownership");
    rateLimitPath = "/v1/tenants/by-external-id";
    const beforeThrottle = sql("select count(*) from tenants");
    const blocked = browser();
    const start = await blocked.request("/auth/start?provider=google");
    const authorize = new URL(start.headers.get("location"));
    authorize.searchParams.set("person", "ada");
    const authorized = await blocked.request(authorize);
    const throttled = await blocked.request(authorized.headers.get("location"));
    assert.equal(throttled.status, 303);
    assert.equal(throttled.headers.get("location"), "/dashboard/sign-in?failed=google");
    assert(throttled.headers.get("X-Request-ID"));
    assert.equal(blocked.cookies.has("local_chalk_session"), false);
    assert.equal(sql("select count(*) from tenants"), beforeThrottle);
    assert.equal((await ada.request("/dashboard-api/home")).status, 200, "A warm session does not repeat tenant lookup");
    rateLimitPath = `/v1/tenants/${firstTenant}/spaces`;
    assert.equal((await ada.request("/dashboard-api/home")).status, 429);
    rateLimitPath = undefined;
    for (const invalid of ["http://example.test:8080", "http://localhost", "https://example.test/path", "https://user@example.test", "https://example.test?query", "http://127.0.0.1:3000"]) {
      assert.equal((await post(ada, "/dashboard-api/developer", { action: "set-allowed-websites", origins: [invalid] }, session.csrfToken)).status, 400, invalid);
    }
    await fetch(`${origin}/fixture/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person: "ada", expire: true }) });
    const expired = await ada.request("/auth/session");
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, "sign_in_required");
    const sensitiveOffset = requests.length;
    assert.equal((await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Test", scopes: ["spaces:read"], expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }, session.csrfToken)).status, 401);
    assert.equal(requests.length, sensitiveOffset);
    assert.equal((await post(ada, "/auth/sign-out", {}, session.csrfToken)).status, 200);
    assert.equal((await ada.request("/auth/session")).status, 401);
    assert.equal(ada.cookies.has("local_chalk_session"), false);
    assert.equal((await post(malik, "/auth/sign-out", {}, other.csrfToken)).status, 200);
    assert.equal(malik.cookies.size, 0);
    console.log("PASS: real Pages OAuth, two identities, idempotent Tenant bootstrap, callback replay, return URLs, exact Origin, CSRF, absolute expiry, sign-out");
    console.log("PASS: real API/PostgreSQL A/B isolation across every named resource action, persisted rename/admission/websites, seat attendance, and bounded retryable 429s without provisioning");
  }
} catch (error) {
  await delay(200);
  console.error(pagesOutput.slice(-8000));
  throw error;
} finally {
  await stopFixturePages(pages, watchdog, deadline);
  await new Promise((resolve) => engine.close(resolve));
  await rm(sandbox, { recursive: true, force: true });
}
