import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

// Run with DASHBOARD_REFRESH_COST=1 through real-engine.sh. Every dashboard
// success comes from the real Pages worker, HTTP API and PostgreSQL repositories.
export async function refreshCost({ client, session, post, origin, engineReads, tenantId }) {
  assert.equal(process.env.CHALK_API_RATE_LIMITS, "on");
  const created = await post(client, "/dashboard-api/home", { action: "create-call", name: "Refresh proof", admission: "knock", idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(created.status, 200, await created.clone().text());
  const { call } = await created.json();
  const joined = await post(client, "/dashboard-api/call", { action: "join", spaceId: call.id, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
  assert.equal(joined.status, 200, await joined.clone().text());
  const episodeId = (await joined.json()).access.subject.episode_id;
  const require = createRequire(new URL("../../package.json", import.meta.url));
  const { chromium } = require("playwright");
  const vite = spawn("pnpm", ["exec", "vite", "--host", "127.0.0.1", "--port", "3072", "--strictPort"], { cwd: new URL("../..", import.meta.url), detached: true, stdio: "ignore" });
  const watchdog = spawn(process.execPath, ["-e", `const owner=${process.pid},group=${vite.pid};setInterval(()=>{try{process.kill(owner,0)}catch{try{process.kill(-group,'SIGTERM')}catch{}process.exit()}},1000);setTimeout(()=>{try{process.kill(-group,'SIGTERM')}catch{}process.exit()},240000)`], {
    stdio: "ignore",
  });
  let browser;
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      assert.equal(vite.exitCode, null, "Task preview must own its port");
      try {
        ready = (await fetch("http://127.0.0.1:3072/dashboard", { signal: AbortSignal.timeout(1000) })).ok;
      } catch {}
      if (ready) break;
      await delay(250);
    }
    assert(ready, "Task preview started");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
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
    await Promise.all([callPage.goto(`http://127.0.0.1:3072/dashboard/call/${call.id}`), homePage.goto("http://127.0.0.1:3072/dashboard")]);
    await callPage.locator(".liveb").waitFor({ state: "visible" });
    await homePage.locator(".live").waitFor({ state: "visible" });
    await delay(500);
    const initialCallReads = dashboardReads.filter((path) => path === "/dashboard-api/call").length;
    const initialHomeReads = dashboardReads.filter((path) => path === "/dashboard-api/home").length;
    assert.equal(await callPage.evaluate(() => document.visibilityState), "visible");
    assert.equal(await homePage.evaluate(() => document.visibilityState), "visible");
    let navigations = 0;
    for (const page of [callPage, homePage])
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations++;
      });
    // Both real browser pages stay open and visible for two complete minutes.
    // This includes page-load fan-out, rather than measuring only cheap ticks.
    await delay(120000);
    const stop = Date.now();
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
    const ended = await post(client, "/dashboard-api/call", { action: "end-for-everyone", spaceId: call.id, episodeId, idempotencyKey: crypto.randomUUID() }, session.csrfToken);
    assert.equal(ended.status, 200, await ended.clone().text());
    await callPage.locator(".liveb").waitFor({ state: "hidden", timeout: 12000 });
    await callPage.locator('.srow a[aria-label^="Session"]').waitFor({ state: "visible", timeout: 12000 });
    await homePage.locator(".live").waitFor({ state: "hidden", timeout: 12000 });
    assert.equal(navigations, 0, "Both pages update without navigation or reload");
    console.log(
      `PASS: refresh-cost ${JSON.stringify({ rateLimits: "on", tenantReads: observed.length, minutes: Number(minutes.toFixed(3)), tenantReadsPerMinute: Number(perMinute.toFixed(2)), fullMinuteWindows: windows, initialCallReads, initialHomeReads, callStatusTicks: dashboardReads.filter((path) => path === "/dashboard-api/call-status").length, homeStatusTicks: dashboardReads.filter((path) => path === "/dashboard-api/home-status").length, liveToEndedWithoutReload: true })}`,
    );
  } finally {
    await browser?.close();
    watchdog.kill("SIGTERM");
    try {
      process.kill(-vite.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (vite.exitCode === null) await once(vite, "exit");
  }
}
