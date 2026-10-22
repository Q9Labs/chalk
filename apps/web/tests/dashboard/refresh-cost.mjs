import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

// Run with DASHBOARD_REFRESH_COST=1 through real-engine.sh. Every dashboard
// success comes from the real Pages worker, HTTP API and PostgreSQL repositories.
export async function refreshCost({ client, session, post, origin, engineReads, engineRequests, tenantId, sql }) {
  assert.equal(process.env.CHALK_API_RATE_LIMITS, "on");
  const created = await post(client, "/dashboard-api/home", { action: "create-call", name: "Refresh proof", admission: "knock", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(created.status, 200, await created.clone().text());
  const { call } = await created.json();
  const joined = await post(client, "/dashboard-api/call", { action: "join", spaceId: call.id, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(joined.status, 200, await joined.clone().text());
  const episodeId = (await joined.json()).access.subject.episode_id;
  assert.equal((await client.request(`/dashboard-api/home-status?spaceIds=${Array(31).fill(call.id).join(",")}`)).status, 400);
  assert.equal((await client.request(`/dashboard-api/home-metadata?spaceIds=${Array(6).fill(call.id).join(",")}`)).status, 400);
  const loadStart = engineRequests.length;
  const loaded = await client.request(`/dashboard-api/call?spaceId=${call.id}`);
  assert.equal(loaded.status, 200);
  const initial = await loaded.json();
  const pageLoad = engineRequests.slice(loadStart);
  const lookupPath = "/v1/tenants/by-external-id?";
  const scoped = (entry) => entry.path.startsWith(`/v1/tenants/${tenantId}/`);
  assert(pageLoad.every((entry) => entry.method === "GET" && entry.status === 200));
  assert.equal(pageLoad.filter((entry) => entry.path.startsWith(lookupPath)).length, 1);
  // Five fixed scoped reads, two per Episode, one per recording (up to 5 x 5).
  assert.equal(pageLoad.filter(scoped).length, 5 + 2 * initial.episodes.length + initial.episodes.reduce((sum, episode) => sum + episode.recordings.length, 0));
  console.log(`PASS: call-page-fanout ${JSON.stringify({ total: pageLoad.length, scoped: pageLoad.filter(scoped).length, unscopedLookups: 1, writes: 0, maximumScoped: 40, maximumTotal: 41 })}`);
  const traffic = (start, stop) => {
    const requests = engineRequests.filter((entry) => entry.at >= start && entry.at < stop);
    assert(
      requests.every((entry) => entry.status === 200),
      "No engine request failed or was throttled",
    );
    const writes = requests.filter((entry) => !["GET", "HEAD"].includes(entry.method));
    assert.equal(writes.length, 0, "Dashboard polling must not write");
    return { scoped: requests.filter(scoped).length, unscopedLookups: requests.filter((entry) => entry.path.startsWith(lookupPath)).length, total: requests.length, writes: writes.length };
  };
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const { chromium } = require("playwright");
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: "block" });
    const dashboardReads = [];
    const activeEpisodes = [];
    await context.route(/\/(?:dashboard-api\/|auth\/session)/, async (route) => {
      const url = new URL(route.request().url());
      dashboardReads.push(url.pathname);
      const response = await client.request(url.pathname + url.search);
      const body = await response.text();
      if (url.pathname === "/dashboard-api/call-status") activeEpisodes.push(JSON.parse(body).episode?.id ?? null);
      await route.fulfill({ status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body });
    });
    const callPage = await context.newPage();
    const homePage = await context.newPage();
    const start = Date.now();
    await Promise.all([callPage.goto(`${origin}/dashboard/call/${call.id}`), homePage.goto(`${origin}/dashboard`)]);
    await callPage.locator(".liveb").waitFor({ state: "visible" });
    await homePage.locator(".live").waitFor({ state: "visible" });
    await delay(500);
    const initialCallReads = dashboardReads.filter((path) => path === "/dashboard-api/call").length;
    const initialHomeReads = dashboardReads.filter((path) => path === "/dashboard-api/home").length;
    assert.equal(await callPage.evaluate(() => document.visibilityState), "visible");
    assert.equal(await homePage.evaluate(() => document.visibilityState), "visible");
    let navigations = 0;
    let measuringNavigation = true;
    for (const page of [callPage, homePage])
      page.on("framenavigated", (frame) => {
        if (measuringNavigation && frame === page.mainFrame()) navigations++;
      });
    // Both real browser pages stay open and visible for two complete minutes.
    // This includes page-load fan-out, rather than measuring only cheap ticks.
    await delay(120000);
    const stop = Date.now();
    const normalTraffic = traffic(start, stop);
    const observed = engineReads.filter((read) => read.at >= start && read.at < stop && read.path.startsWith(`/v1/tenants/${tenantId}/`));
    assert(
      observed.every((read) => read.status === 200),
      "No tenant read failed or was throttled",
    );
    const minutes = (stop - start) / 60000;
    const perMinute = observed.length / minutes;
    const windows = [0, 1].map((index) => observed.filter((read) => read.at >= start + index * 60000 && read.at < start + (index + 1) * 60000).length);
    assert(perMinute <= 60 && windows.every((count) => count <= 60), `Tenant reads exceed budget: ${perMinute}; windows ${windows}`);
    assert.equal(dashboardReads.filter((path) => path === "/dashboard-api/call").length, initialCallReads);
    assert.equal(dashboardReads.filter((path) => path === "/dashboard-api/home").length, initialHomeReads);
    assert(dashboardReads.filter((path) => path === "/dashboard-api/call-status").length >= 23);
    assert(dashboardReads.filter((path) => path === "/dashboard-api/home-status").length >= 23);
    assert(
      activeEpisodes.every((id) => id === episodeId),
      "The sample stayed live for the whole measurement",
    );
    assert.equal(await callPage.locator(".liveb").count(), 1);
    assert.equal(await homePage.locator(".live").count(), 1);
    // Measure the faster shared poll with a real pending admission, no second loop.
    measuringNavigation = false;
    await homePage.goto("about:blank");
    const inviteToken = new URLSearchParams(new URL(initial.inviteUrl).hash.slice(1)).get("spaceInviteToken");
    const arrival = await fetch(`${process.env.DASHBOARD_TEST_API_ORIGIN}/v1/public/space-invite-arrivals`, {
      method: "POST",
      headers: { Authorization: "Bearer fixture-dashboard-service-token-not-a-secret", "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ space_invite_token: inviteToken, display_name: "Budget guest" }),
    });
    assert.equal(arrival.status, 201, await arrival.clone().text());
    sql(`update space_public_admission_requests set expires_at=now()+interval '5 minutes' where space_id='${call.id}' and state='pending'`);
    await callPage.locator(".orow").waitFor({ state: "visible", timeout: 12000 });
    await delay(500);
    const pendingStart = Date.now();
    const pendingTicks = dashboardReads.filter((path) => path === "/dashboard-api/call-status").length;
    await delay(60000);
    const pendingTraffic = traffic(pendingStart, Date.now());
    const ticks = dashboardReads.filter((path) => path === "/dashboard-api/call-status").length - pendingTicks;
    assert(ticks >= 19 && ticks <= 21, `Expected three-second status cadence, got ${ticks}`);
    assert(pendingTraffic.scoped <= 52 && pendingTraffic.unscopedLookups <= 26);
    assert.equal(dashboardReads.filter((path) => path === "/dashboard-api/call").length, initialCallReads);
    console.log(
      `PASS: refresh-cost-all-buckets ${JSON.stringify({ normalTwoPagesTwoMinutes: normalTraffic, pendingOnePageOneMinute: { ...pendingTraffic, ticks }, limitsPerMinute: { tenantRead: 300, tenantWrite: 60, serviceScopedRead: 6000, serviceUnscopedRead: 300 }, conservativeSinglePagePerMinute: { normal: { scoped: 36, unscoped: 18, total: 54, writes: 0 }, pending: { scoped: 52, unscoped: 26, total: 78, writes: 0 } } })}`,
    );
    // Let the end transition checks continue to observe both pages.
    await homePage.goto(`${origin}/dashboard`);
    await homePage.locator(".live").waitFor({ state: "visible" });
    measuringNavigation = true;
    const ended = await post(client, "/dashboard-api/call", { action: "end-for-everyone", spaceId: call.id, episodeId, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(ended.status, 200, await ended.clone().text());
    // This API/Postgres fixture has no Sync lifecycle consumer. Complete its
    // shutdown acknowledgement in storage; browser responses still use the API.
    assert.equal(sql(`update episodes set status='ended', ended_at=now() where id='${episodeId}' and tenant_id='${tenantId}' and status='ending' returning id`), episodeId);
    await callPage.locator(".liveb").waitFor({ state: "hidden", timeout: 12000 });
    await callPage.locator('.srow a[aria-label^="Session"]').waitFor({ state: "visible", timeout: 12000 });
    await homePage.locator(".live").waitFor({ state: "hidden", timeout: 12000 });
    assert.equal(navigations, 0, "Both pages update without navigation or reload");
    const finalMetadata = await client.request(`/dashboard-api/home-metadata?spaceIds=${call.id}`);
    assert.equal(finalMetadata.status, 200);
    const endedRow = (await finalMetadata.json()).calls[0];
    assert.equal(Date.parse(endedRow.lastActiveAt), Date.parse(sql(`select ended_at from episodes where id='${episodeId}'`)), "End timestamp comes from the real Episode");
    console.log(
      `PASS: refresh-cost ${JSON.stringify({ rateLimits: "on", tenantReads: observed.length, minutes: Number(minutes.toFixed(3)), tenantReadsPerMinute: Number(perMinute.toFixed(2)), fullMinuteWindows: windows, initialCallReads, initialHomeReads, callStatusTicks: dashboardReads.filter((path) => path === "/dashboard-api/call-status").length, homeStatusTicks: dashboardReads.filter((path) => path === "/dashboard-api/home-status").length, liveToEndedWithoutReload: true })}`,
    );
    // Delete a real pending transcript between browser ticks, without mocking success.
    measuringNavigation = false;
    await homePage.goto("about:blank");
    const recordingId = crypto.randomUUID();
    const transcriptId = crypto.randomUUID();
    sql(`insert into recordings(id,tenant_id,space_id,episode_id,status,storage_provider) values('${recordingId}','${tenantId}','${call.id}','${episodeId}','completed','r2');
      insert into transcriptions(id,tenant_id,space_id,episode_id,recording_id,status,languages) values('${transcriptId}','${tenantId}','${call.id}','${episodeId}','${recordingId}','pending','{en}');`);
    await callPage.reload();
    await callPage.getByText("Transcript processing", { exact: true }).waitFor();
    const fullBeforeDeletion = dashboardReads.filter((path) => path === "/dashboard-api/call").length;
    sql(`delete from transcriptions where id='${transcriptId}' and tenant_id='${tenantId}'`);
    await callPage.getByText("Transcript processing", { exact: true }).waitFor({ state: "hidden", timeout: 20000 });
    assert.equal(await callPage.locator(".errp").count(), 0);
    assert.equal(await callPage.locator(".srow").count(), 1);
    const ticksAfterDeletion = dashboardReads.filter((path) => path === "/dashboard-api/call-status").length;
    await delay(5500);
    assert(dashboardReads.filter((path) => path === "/dashboard-api/call-status").length > ticksAfterDeletion);
    assert.equal(dashboardReads.filter((path) => path === "/dashboard-api/call").length, fullBeforeDeletion);
    assert(engineRequests.some((entry) => entry.path.endsWith(`/transcripts/${transcriptId}`) && entry.status === 404));
    console.log("PASS: real pending transcript deletion returns 404; browser removes it, retains Call and continues shared status polling without history reload");
  } finally {
    await browser?.close();
  }
}
