import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// A recording transport forwards every operation to the real API. Fault injection
// exercises rate-limit handling only; no engine success response is fabricated.
assert(process.env.DASHBOARD_TEST_API_ORIGIN, "Run through tests/dashboard/real-engine.sh");
const requests = [];
const unsupportedBodies = [];
let rateLimitPath;
const engine = createServer(async (request, response) => {
  requests.push(request.url);
  let body = "";
  for await (const part of request) body += part;
  unsupportedBodies.push({ method: request.method, path: new URL(request.url, "http://localhost").pathname, body });
  if (rateLimitPath && request.url.startsWith(rateLimitPath)) {
    response.writeHead(429, { "Content-Type": "application/json", "Retry-After": "3600" }).end(JSON.stringify({ error: { code: "request.rate_limited", message: "fixture transport throttle" } }));
    return;
  }
  try {
    const upstream = await fetch(new URL(request.url, process.env.DASHBOARD_TEST_API_ORIGIN), { method: request.method, headers: request.headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : body, redirect: "manual" });
    const result = Buffer.from(await upstream.arrayBuffer());
    if (["GET", "POST"].includes(request.method) && new URL(request.url, "http://localhost").pathname.endsWith("/transcripts") && upstream.status < 300) {
      await writeFile(resolve(import.meta.dirname, "../../../../artifacts/dashboard-engine-transcripts.json"), result);
    }
    if (upstream.status >= 400) console.error("Engine failure:", request.method, new URL(request.url, "http://localhost").pathname, upstream.status, result.toString().slice(0, 2048));
    response.writeHead(upstream.status, Object.fromEntries(upstream.headers)).end(result);
  } catch {
    response.writeHead(503).end();
  }
});
async function tenantFor(person) {
  const response = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/tenants/by-external-id?external_id=workos:test:fixture_${person}`, { headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret" } });
  assert.equal(response.status, 200);
  return response.json();
}
function sql(statement) {
  return execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-Atqc", statement], { encoding: "utf8" }).trim();
}
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
        const exposed = (await response.clone().text()) + JSON.stringify([...response.headers]);
        for (const secret of ["fixture-dashboard-service-token-not-a-secret", "fixture-workos-access-token-not-for-browser", "fixture-workos-refresh-token-not-for-browser", "fixture-workos-not-a-secret", "fixture-local-system-not-a-secret", "fixture-only-cookie-password-32-characters"])
          assert(!exposed.includes(secret), `Browser exposed ${secret}`);
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
    assert.equal((await client.request(callback)).headers.get("location"), "/dashboard/sign-in?failed=google");
    client.cookies.set("local_chalk_login", loginCookie);
    assert.equal((await client.request(callback)).headers.get("location"), "/dashboard/sign-in?failed=google");
    const response = await client.request("/auth/session");
    assert.equal(response.status, 200);
    const dto = await response.json();
    assert.deepEqual(Object.keys(dto).sort(), ["csrfToken", "profile"]);
    assert(!JSON.stringify(dto).includes("fixture-dashboard-service-token-not-a-secret"));
    assert(!JSON.stringify(dto).includes("fixture-workos-not-a-secret"));
    return dto;
  }
  async function post(client, path, value, token, extra = {}) {
    return client.request(path, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": token, ...extra }, body: JSON.stringify(value) });
  }
  const ada = browser();
  let session = await signIn(ada, "ada");
  const firstTenant = (await tenantFor("ada")).id;
  await signIn(ada, "ada");
  assert.equal((await tenantFor("ada")).id, firstTenant);
  assert.equal(sql("select count(*) from tenants where external_id = 'workos:test:fixture_ada'"), "1");
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
  const failedApple = await apple.request("/auth/callback?error=access_denied");
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
  assert.equal(rawInvite.status, 400, "Reproduce engine Unicode invite rejection");
  const unicodeHome = await ada.request("/dashboard-api/home");
  assert.equal(unicodeHome.status, 200, await unicodeHome.clone().text());
  assert.equal((await unicodeHome.json()).calls.find((call) => call.id === unicodeId).inviteUrl, null);
  const unicodeCall = await ada.request(`/dashboard-api/call?spaceId=${unicodeId}`);
  assert.equal(unicodeCall.status, 200, await unicodeCall.clone().text());
  assert.equal((await unicodeCall.json()).inviteUrl, null);
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
    assert.equal((await ownPast.json()).attendance.participants[0].isYou, true);
    sql(
      `update participants set status='joining', joined_at=null, first_joined_at=null where id='${grant.subject.participant_id}'; update sync_episode_control set folded_state=jsonb_set(folded_state,'{participants}','[]'::jsonb) where tenant_id='${firstTenant}' and episode_id='${grant.subject.episode_id}'`,
    );
    const refreshedAccess = await post(ada, "/dashboard-api/call", { action: "refresh-access", spaceId: ownerSpaceId }, session.csrfToken);
    // Before Sync has committed participant_joined, refresh must fail closed.
    assert.equal(refreshedAccess.status, 404, await refreshedAccess.clone().text());
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
  }
  console.log("PASS: owner open/knock direct grants, same-key seat replay, pre-Sync refresh rejection, new-key rejoin seat, guest knock still waits");
  const keyResponse = await post(ada, "/dashboard-api/developer", { action: "create-key", name: "Test", scopes: ["spaces:read"], expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(keyResponse.status, 200, await keyResponse.clone().text());
  const keyId = (await keyResponse.json()).id;
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
  sql(`update webhook_deliveries set attempt_count=1, state='succeeded', next_attempt_at=null, terminal_at=now() where id='${testDeliveryId}';
  insert into webhook_delivery_attempts(id,tenant_id,delivery_id,attempt_number,started_at,finished_at,latency_milliseconds,outcome,http_status) values(gen_random_uuid(),'${firstTenant}','${testDeliveryId}',1,now(),now(),1,'succeeded',204);
  update api_keys set last_used_at='2026-10-18T00:00:00Z' where id='${keyId}'`);
  const developer = await ada.request("/dashboard-api/developer");
  assert.equal(developer.status, 200, await developer.clone().text());
  const developerDTO = await developer.json();
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
  assert(pastDTO.attendance.participants.every((p) => p.name === "Same name" && p.kind === "guest" && p.isYou === false && p.firstJoinedAt && p.lastLeftAt === pastDTO.episode.endedAt));
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
  for (const path of [`/dashboard-api/call?spaceId=${spaceId}`, `/dashboard-api/past-session?spaceId=${spaceId}&episodeId=${foreign.episodeId}`]) assert.equal((await malik.request(path)).status, 404);
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
  assert.equal((await post(malik, "/dashboard-api/call", { action: "refresh-access", spaceId: foreign.spaceId }, other.csrfToken)).status, 401);
  assert.equal((await post(malik, "/dashboard-api/call", { action: "refresh-access", spaceId: foreign.spaceId, participantId: foreign.recordingId }, other.csrfToken)).status, 400);
  assert.equal((await post(malik, "/dashboard-api/home", { action: "archive-call", spaceId: foreign.spaceId, tenantId: firstTenant }, other.csrfToken)).status, 400);

  assert.equal((await post(malik, "/dashboard-api/developer", { action: "set-allowed-websites", origins: ["https://example.test", "http://localhost:3000"] }, other.csrfToken)).status, 200);
  assert.deepEqual(unsupportedBodies.at(-1), { method: "PATCH", path: `/v1/tenants/${secondTenant}`, body: JSON.stringify({ cors_allowed_origins: ["https://chalkmeet.com", "https://example.test", "http://localhost:3000"] }) });
  const websites = await post(malik, "/dashboard-api/developer", { action: "allowed-websites" }, other.csrfToken);
  assert.equal(websites.status, 200);
  const expectedWebsites = ["https://chalkmeet.com", "https://example.test", "http://localhost:3000"].toSorted();
  assert.deepEqual((await websites.json()).allowedWebsites.toSorted(), expectedWebsites);
  assert.deepEqual((await tenantFor("malik")).cors_allowed_origins.toSorted(), expectedWebsites);
  const homeOffset = requests.length;
  const home = await ada.request("/dashboard-api/home");
  assert.equal(home.status, 200, await home.clone().text());
  const homeDTO = await home.json();
  assert(requests.length - homeOffset <= 18, "Home enrichment stays within its request bound");
  assert.equal(homeDTO.live.find((row) => row.spaceId === spaceId).episode, null);
  const homeCall = homeDTO.calls.find((row) => row.id === spaceId);
  assert(homeCall.inviteUrl && homeCall.slug && homeCall.lastActiveAt);
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
  assert.equal((await ada.request("/dashboard-api/home")).status, 429);
  rateLimitPath = `/v1/tenants/${firstTenant}/spaces`;
  assert.equal((await ada.request("/dashboard-api/home")).status, 429);
  rateLimitPath = undefined;
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
    { action: "rotate-key", keyId, expiresAt: "2027-01-01T00:00:00Z", idempotencyKey: crypto.randomUUID() },
    { action: "rotate-webhook-secret", webhookId, revokePreviousImmediately: true, idempotencyKey: crypto.randomUUID() },
  ];
  const sensitiveOffset = requests.length;
  const sensitiveBodyOffset = unsupportedBodies.length;
  for (const action of sensitive) assert.equal((await post(ada, "/dashboard-api/developer", action, session.csrfToken)).status, 401);
  assert.equal(unsupportedBodies.slice(sensitiveBodyOffset).filter((r) => r.method !== "GET").length, 0);
  assert(!requests.slice(sensitiveOffset).some((path) => /api-keys|webhook-endpoints/.test(path)));
  assert.equal((await post(ada, "/auth/sign-out", {}, session.csrfToken)).status, 200);
  assert.equal((await ada.request("/auth/session")).status, 401);
  await fetch(`${origin}/fixture/control`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ person: "malik", refresh: "terminal" }) });
  const terminal = await post(malik, "/auth/refresh", {}, other.csrfToken);
  assert.equal(terminal.status, 401);
  const terminalRequestId = terminal.headers.get("X-Request-ID");
  assert(terminalRequestId);
  await delay(100);
  assert(pagesOutput.includes(terminalRequestId), "terminal refresh must log its returned request ID");
  assert.equal(malik.cookies.size, 0);
  console.log("PASS: real Pages auth, two identities, idempotent Tenant bootstrap, callback replay, return URLs, exact Origin, CSRF, refresh success/transient/terminal, online-gated secrets, sign-out");
  console.log("PASS: real API/PostgreSQL A/B isolation across every named resource action, persisted rename/admission/websites, seat attendance, and bounded retryable 429s without provisioning");
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
