import { strict as assert } from "node:assert";

/** Part of the dashboard end-to-end journey. */
export async function homeChecks(h, s) {
  const { origin, apiOrigin, requests, unsupportedBodies, tenantFor, post } = h;
  const { ada, malik, other, secondTenant, spaceId } = s;

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
}

/** Part of the dashboard end-to-end journey. */
export async function endChecks(h, s) {
  const { origin, requests, throttle, sql, browser, post } = h;
  const { ada, firstTenant, malik, other, session } = s;
  throttle.path = "/v1/tenants/by-external-id";
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
  throttle.path = `/v1/tenants/${firstTenant}/spaces`;
  assert.equal((await ada.request("/dashboard-api/home")).status, 429);
  throttle.path = undefined;
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
