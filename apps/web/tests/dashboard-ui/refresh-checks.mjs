import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export async function pendingMetadataChecks({ open, fixture, check, CALL }) {
  const reads = async (page) => (await fixture("log")).filter((entry) => entry.method === "GET" && entry.path === `/dashboard-api/${page}`).length;
  for (const final of ["complete", "terminal_failure"]) {
    const { tab, context } = await open(CALL, { set: "live=0&knocks=0" });
    await tab.getByRole("button", { name: "Anyone with the link", exact: true }).click();
    await tab.waitForTimeout(500);
    const full = await reads("call");
    await tab.getByText("Transcript processing", { exact: true }).waitFor({ state: "visible" });
    await fixture(`set?metadataComplete=${final}`);
    const finished = await tab
      .getByText("Transcript processing", { exact: true })
      .waitFor({ state: "hidden", timeout: 25000 })
      .then(
        () => true,
        () => false,
      );
    check(`ended Anyone Call updates pending transcript metadata to ${final} without reloading history`, finished && (await reads("call-metadata")) >= 2 && (await reads("call")) === full);
    const status = await reads("call-status");
    await tab.waitForTimeout(5500);
    check(`ended Anyone Call stops polling after artifacts reach ${final}`, finished && (await reads("call-status")) === status);
    await context.close();
  }
}

export async function refreshChecks({ open, fixture, check, CALL }) {
  await budgetChecks({ open, fixture, check, CALL });
  await pendingMetadataChecks({ open, fixture, check, CALL });
  const visible = (tab, selector, timeout = 8000) =>
    tab
      .locator(selector)
      .waitFor({ state: "visible", timeout })
      .then(
        () => true,
        () => false,
      );
  const reads = async (page) => (await fixture("log")).filter((entry) => entry.method === "GET" && entry.path === `/dashboard-api/${page}`).length;
  const screenshot = async (tab, name) => {
    if (!process.env.DASHBOARD_REFRESH_ARTIFACTS) return;
    await mkdir(process.env.DASHBOARD_REFRESH_ARTIFACTS, { recursive: true });
    await tab.screenshot({ path: resolve(process.env.DASHBOARD_REFRESH_ARTIFACTS, `${name}.png`), fullPage: true });
  };
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=0&liveParticipants=0" });
    const full = await reads("call");
    await fixture("set?liveParticipants=1");
    check(
      "Call updates the roster during a stable Episode without reloading history",
      (await tab
        .locator(".liveb .mu")
        .filter({ hasText: "Nora is in the call." })
        .waitFor({ state: "visible", timeout: 15000 })
        .then(
          () => true,
          () => false,
        )) && (await reads("call")) === full,
    );
    await context.close();
  }
  for (const page of ["call", "home"]) {
    const { tab, context } = await open(page === "call" ? CALL : "/dashboard", { set: "freshLive=1&knocks=0" });
    const full = await reads(page);
    const status = await reads(`${page}-status`);
    await tab.waitForTimeout(10500);
    check(`${page} ticks read status, not the full page`, (await reads(`${page}-status`)) >= status + 2 && (await reads(page)) === full);
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1&liveParticipants=0&knocks=1" });
    let navigations = 0;
    tab.on("framenavigated", (frame) => {
      if (frame === tab.mainFrame()) navigations++;
    });
    await screenshot(tab, "live");
    await fixture("set?ending=1&knocks=0");
    check("Call shows the ending session during engine shutdown", await visible(tab, '.srow a[aria-label^="Session"]'));
    await fixture("set?end=1");
    const ended = await visible(tab, '.srow a[aria-label*=", 7 min,"]', 40000);
    await screenshot(tab, "ended");
    check("Call refreshes live to ended, lists the recording and drops stale knocks without navigation", ended && navigations === 0 && (await tab.locator(".liveb,.orow").count()) === 0 && (await tab.locator(".srow").getByText("Recording", { exact: true }).count()) === 1);
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "live=0&knocks=0" });
    await fixture("set?freshLive=1&end=1");
    check("Call discovers a session that started and ended between polls", await visible(tab, '.srow a[aria-label*=", 7 min,"]'));
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "live=0&knocks=0" });
    await fixture("set?knocks=1");
    const arrived = await visible(tab, ".orow");
    await screenshot(tab, "first-knock");
    check("idle Ask to join Call discovers its first knock without navigation or visibility changes", arrived);
    await context.close();
  }
  {
    // A pending request alone must keep refreshing, even without a live Episode.
    const { tab, context } = await open(CALL, { set: "live=0&knocks=1" });
    await fixture("set?knocks=0");
    const removed = await tab
      .locator(".orow")
      .waitFor({ state: "hidden", timeout: 8000 })
      .then(
        () => true,
        () => false,
      );
    check("Call drops a pending knock when the server stops returning it", removed);
    await fixture("set?knocks=1");
    const next = await visible(tab, ".orow");
    check("Call keeps observing new knocks after the last one disappears", next);
    if (next) {
      await tab.getByRole("button", { name: "Deny", exact: true }).click();
      await tab.locator(".orow").waitFor({ state: "hidden" });
      await fixture("set?knocks=1");
      check("Call keeps observing new knocks after denying the last one", await visible(tab, ".orow"));
    }
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "live=0&knocks=0&metadataComplete=complete" });
    await tab.getByRole("button", { name: "Anyone with the link", exact: true }).click();
    await tab.waitForTimeout(500);
    const before = await reads("call-status");
    await tab.waitForTimeout(5500);
    check("idle Anyone with the link Call does not poll", (await reads("call-status")) === before);
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard", { set: "live=1" });
    await fixture("set?live=0");
    const ended = await tab
      .locator(".live")
      .waitFor({ state: "hidden", timeout: 8000 })
      .then(
        () => true,
        () => false,
      );
    const stopped = await reads("home-status");
    await tab.waitForTimeout(5500);
    check("Home clears Live without a reload and stops polling when idle", ended && (await reads("home-status")) === stopped);
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1" });
    // Chromium headless has no background-tab lifecycle; dispatch the browser's visibility contract.
    await tab.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const before = await reads("call-status");
    await fixture("set?end=1");
    await tab.waitForTimeout(5500);
    check("hidden tab does not poll", (await reads("call-status")) === before);
    await tab.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    check("visible tab refreshes immediately", await visible(tab, '.srow a[aria-label^="Session"]'));
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1" });
    await fixture("set?fail=call-status");
    const before = await reads("call-status");
    await tab.waitForTimeout(5500);
    check("failed background refresh keeps ready content without a skeleton or error", (await reads("call-status")) > before && (await tab.locator(".liveb").count()) === 1 && (await tab.locator('[aria-busy="true"],.errp').count()) === 0);
    await fixture("set?fail=&end=1");
    check("background refresh retries after failure", await visible(tab, '.srow a[aria-label^="Session"]'));
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1" });
    await fixture("set?expire=1");
    await tab.waitForURL("**/dashboard/sign-in**", { timeout: 8000 }).catch(() => {});
    check("background 401 still redirects to sign-in", new URL(tab.url()).pathname === "/dashboard/sign-in");
    await context.close();
  }
  {
    const { tab, context } = await open(CALL, { set: "live=1" });
    await tab.getByRole("button", { name: "Show older sessions" }).click();
    await tab.waitForTimeout(500);
    const rows = await tab.locator(".srow").count();
    await tab.waitForTimeout(5500);
    check("Call refresh keeps previously opened history pages", rows === 9 && (await tab.locator(".srow").count()) === rows);
    await context.close();
  }
  {
    const { tab, context } = await open("/dashboard/developer");
    await fixture("set?fail=webhook-deliveries");
    await tab.getByRole("button", { name: "Send test event" }).click();
    const failure = await tab
      .getByText("Couldn’t load deliveries", { exact: true })
      .waitFor({ state: "visible", timeout: 4000 })
      .then(
        () => true,
        () => false,
      );
    check("explicit non-polling reload still exposes its error and retry", failure && (await tab.getByRole("button", { name: "Try again" }).count()) === 1);
    await context.close();
  }
  for (const action of ["deny", "admission", "rename"]) {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=1" });
    let release;
    let captured;
    const held = new Promise((accept) => {
      release = accept;
    });
    const started = new Promise((accept) => {
      captured = accept;
    });
    await tab.route(
      "**/dashboard-api/call?*",
      async (route) => {
        const response = await route.fetch();
        captured();
        await held;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    // Force a read before the write, then deliver its stale response after the write.
    await tab.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const raced = await Promise.race([started.then(() => true), tab.waitForTimeout(6000).then(() => false)]);
    if (action === "deny") await tab.getByRole("button", { name: "Deny", exact: true }).click();
    if (action === "admission") await tab.getByRole("button", { name: "Anyone with the link", exact: true }).click();
    if (action === "rename") {
      await tab.getByRole("button", { name: "More actions for Q9 team" }).click();
      await tab.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await tab.getByRole("dialog").getByRole("textbox").fill("Sample renamed call");
      await tab.getByRole("button", { name: "Save name", exact: true }).click();
    }
    await tab.waitForTimeout(500);
    release();
    await tab.waitForTimeout(500);
    const kept =
      action === "deny" ? (await tab.locator(".orow").count()) === 0 : action === "rename" ? (await tab.getByRole("heading", { name: "Sample renamed call" }).count()) === 1 : (await tab.getByRole("button", { name: "Anyone with the link", exact: true }).getAttribute("aria-pressed")) === "true";
    check(`stale refresh cannot undo ${action}`, raced && kept);
    await context.close();
  }
}

// Accelerate browser time, not network replies: these drive the mounted pages and real hook.
async function budgetChecks({ open, fixture, check, CALL }) {
  const reads = async (page) => (await fixture("log")).filter((entry) => entry.method === "GET" && entry.path === `/dashboard-api/${page}`).length;
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=0", clock: true });
    try {
      const initial = await reads("call");
      for (let tick = 0; tick < 12; tick++) {
        await fixture(`set?knocks=${tick % 2 ? 0 : 1}`);
        const response = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-status"));
        await tab.clock.runFor(5000);
        await response;
        await tab.locator(".orow").waitFor({ state: tick % 2 ? "hidden" : "visible" });
      }
      check("twelve knock changes apply without a full Call read", (await reads("call")) === initial);
      await tab.route("**/dashboard-api/call-status?*", async (route) => {
        const response = await route.fetch();
        const status = await response.json();
        await route.fulfill({ response, json: { ...status, latestEpisodeId: "00000000-0000-4000-8000-000000009999" } });
      });
      const refreshes = [];
      tab.on("request", (request) => {
        if (new URL(request.url()).pathname === "/dashboard-api/call") refreshes.push(request.url());
      });
      for (let tick = 0; tick < 7; tick++) {
        const response = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-status"));
        const full = tick === 0 || tick === 6 ? tab.waitForResponse((response) => new URL(response.url()).pathname === "/dashboard-api/call") : undefined;
        await tab.clock.runFor(5000);
        await response;
        await full;
        // Let React apply the HTTP response before advancing the next interval.
        await tab.waitForTimeout(50);
        check(`Episode churn tick ${tick + 1} respects the 30-second bound`, refreshes.length === (tick < 6 ? 1 : 2));
      }
      await tab.unroute("**/dashboard-api/call-status?*");
      await fixture("set?end=1&knocks=0");
      for (let tick = 0; tick < 6; tick++) {
        await tab.clock.runFor(5000);
        await tab.waitForTimeout(50);
      }
      check("coalesced Episode refresh fetches the final ended state", (await tab.locator(".liveb").count()) === 0 && refreshes.length === 3);
    } finally {
      await context.close();
    }
  }
  for (const count of [31, 100]) {
    const { tab, context } = await open("/dashboard", { set: "live=1", clock: true });
    try {
      let full = 0;
      let fail = true;
      const batches = [];
      const metadataBatches = [];
      const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
      await tab.route("**/dashboard-api/home", async (route) => {
        full++;
        const response = await route.fetch();
        const data = await response.json();
        const calls = Array.from({ length: count }, (_, index) => ({ ...data.calls[0], id: uuid(0x8000 + index), name: `Live call ${index}` }));
        await route.fulfill({ response, json: { ...data, calls, live: calls.map((call) => ({ spaceId: call.id, episode: { ...data.live[0].episode, id: uuid(0x9000 + Number.parseInt(call.id.slice(-4), 16)) } })) } });
      });
      await tab.route("**/dashboard-api/home-status?*", async (route) => {
        const ids = new URL(route.request().url()).searchParams.get("spaceIds").split(",");
        batches.push(ids);
        if (fail && batches.length === 2) {
          fail = false;
          await route.fulfill({ status: 503, json: { error: "service_unavailable" } });
        } else await route.fulfill({ json: { live: ids.map((spaceId) => ({ spaceId, episode: null })) } });
      });
      await tab.route("**/dashboard-api/home-metadata?*", async (route) => {
        const ids = new URL(route.request().url()).searchParams.get("spaceIds").split(",");
        metadataBatches.push(ids);
        await route.fulfill({ json: { calls: ids.map((id) => ({ id, lastActiveAt: "2026-01-01T12:00:00Z", recentPeople: [{ id: uuid(0x700), name: "Final guest" }] })) } });
      });
      await tab.reload();
      await tab.locator(".live").first().waitFor({ state: "visible" });
      await tab.waitForLoadState("networkidle");
      const initialFull = full;
      const interval = 5000 * Math.ceil(count / 30);
      await tab.clock.runFor(interval);
      await tab.waitForTimeout(200);
      check(`Home ${count} retains live data after a failed batch`, batches.length === 2 && (await tab.locator(".live").count()) === count);
      await tab.clock.runFor(interval);
      await tab.locator(".live").first().waitFor({ state: "hidden" });
      const recovered = batches.slice(2).flat();
      check(
        `Home ${count} batches at most 30 ids and recovers next tick`,
        batches.every((ids) => ids.length <= 30) && recovered.length === count && new Set(recovered).size === count && initialFull >= 1 && full === initialFull,
        JSON.stringify({ batches: batches.map((ids) => ids.length), recovered: recovered.length, distinct: new Set(recovered).size, initialFull, full }),
      );
      const stopped = batches.length;
      for (let tick = 1; tick < Math.ceil(count / 5); tick++) {
        const response = tab.waitForResponse((response) => response.url().includes("/dashboard-api/home-metadata"));
        await tab.clock.runFor(5000);
        await response;
        await tab.waitForTimeout(50);
      }
      check(`Home ${count} refreshes ended timestamps in bounded metadata batches`, metadataBatches.every((ids) => ids.length <= 5) && new Set(metadataBatches.flat()).size === count && (await tab.locator('.ra[aria-label*="1 Jan"]').count()) === count);
      const finished = metadataBatches.length;
      await tab.clock.runFor(interval * 2);
      check(`Home ${count} stops polling after ended metadata drains`, batches.length === stopped && metadataBatches.length === finished);
    } finally {
      await context.close();
    }
  }
}
