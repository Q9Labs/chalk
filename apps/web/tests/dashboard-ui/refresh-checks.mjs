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
    check(`ended Anyone Call updates pending transcript metadata to ${final} without reloading history`, finished && (await reads("call-metadata")) >= 1 && (await reads("call")) === full);
    const status = await reads("call-status");
    await tab.waitForTimeout(5500);
    check(`ended Anyone Call stops polling after artifacts reach ${final}`, finished && (await reads("call-status")) === status);
    await context.close();
  }
}

export async function artifactRecoveryChecks({ open, fixture, check, CALL }) {
  const reads = async (page) => (await fixture("log")).filter((entry) => entry.method === "GET" && entry.path === `/dashboard-api/${page}`).length;
  const metadataTick = async (tab) => {
    const metadata = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-metadata"));
    for (let tick = 0; tick < 2; tick++) {
      const status = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-status"));
      await tab.clock.runFor(5000);
      await status;
      await tab.waitForLoadState("networkidle");
    }
    await metadata;
  };
  {
    const { tab, context } = await open(CALL, { set: "live=0&knocks=0&metadataDiscovery=pending", clock: true });
    try {
      const full = await reads("call");
      check("completed recording waits for pending automatic transcription", (await tab.getByText("Transcript", { exact: true }).count()) === 0);
      await fixture("set?metadataDiscovery=ready");
      await metadataTick(tab);
      await tab.getByText("Transcript", { exact: true }).waitFor();
      const status = await reads("call-status");
      await tab.clock.runFor(15000);
      check("Call discovers a new automatic transcript and stops polling without a full reload", (await reads("call")) === full && (await reads("call-status")) === status);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open(CALL, { set: "live=0&knocks=0&metadataDiscovery=ready&metadataComplete=retryable_failure", clock: true });
    try {
      const full = await reads("call");
      await tab.getByText("Transcript processing", { exact: true }).waitFor();
      await fixture("set?metadataComplete=complete");
      await metadataTick(tab);
      await tab.getByText("Transcript processing", { exact: true }).waitFor({ state: "hidden" });
      await tab.getByText("Transcript", { exact: true }).waitFor();
      check("retryable transcripts keep polling until automatic recovery completes", (await reads("call")) === full);
    } finally {
      await context.close();
    }
  }
}

export async function refreshChecks({ open, fixture, check, CALL }) {
  await missingMetadataChecks({ open, fixture, check, CALL });
  await archivedPollingChecks({ open, fixture, check });
  await pollingBackoffChecks({ open, fixture, check, CALL });
  await budgetChecks({ open, fixture, check, CALL });
  await artifactRecoveryChecks({ open, fixture, check, CALL });
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
    for (let tick = 0; tick < 2; tick++) {
      await tab.waitForResponse((response) => new URL(response.url()).pathname === `/dashboard-api/${page}-status` && response.ok(), { timeout: 20000 });
    }
    const observed = await reads(`${page}-status`);
    check(`${page} ticks read status, not the full page`, observed >= status + 2 && (await reads(page)) === full, `status reads=${observed - status}, page reads=${full}->${await reads(page)}`);
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
    check("background refresh retries after failure", await visible(tab, '.srow a[aria-label^="Session"]', 15000));
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
    const full = await reads("call");
    await tab.getByRole("button", { name: "Show older sessions" }).click();
    await tab.waitForTimeout(500);
    check("Call pagination reads only the appended page", (await reads("call")) === full + 1);
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
      "**/dashboard-api/call-status?*",
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

export async function missingMetadataChecks({ open, fixture, check, CALL }) {
  for (const status of [403, 404, 410]) {
    const { tab, context } = await open(CALL, { set: "live=0&knocks=0&metadataDiscovery=ready&metadataComplete=retryable_failure&admission=knock", clock: true });
    try {
      await tab.getByText("Transcript processing", { exact: true }).waitFor();
      const reads = async (page) => (await fixture("log")).filter((entry) => entry.path === `/dashboard-api/${page}`).length;
      const full = await reads("call");
      await tab.route("**/dashboard-api/call-metadata?*", (route) => route.fulfill({ status, json: { error: { code: "artifact_unavailable" } } }));
      for (let tick = 0; tick < 2; tick++) {
        const response = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-status"));
        await tab.clock.runFor(5000);
        await response;
        await tab.waitForLoadState("networkidle");
      }
      check(`metadata ${status} removes the transcript while keeping Call available`, (await tab.locator(".errp").count()) === 0 && (await tab.getByText("Transcript processing", { exact: true }).count()) === 0 && (await tab.locator(".srow").count()) > 0);
      if (status === 404) {
        await mkdir(resolve("artifacts/dashboard-followups"), { recursive: true });
        await tab.screenshot({ path: resolve(`artifacts/dashboard-followups/metadata-${process.env.DASHBOARD_FOLLOWUP_PROOF ?? "after"}.png`), fullPage: true });
      }
      const before = await reads("call-status");
      await tab.clock.runFor(5000);
      await tab.waitForLoadState("networkidle");
      check(`metadata ${status} keeps shared status polling without reloading history`, (await reads("call-status")) > before && (await reads("call")) === full);
    } finally {
      await context.close();
    }
  }
}

export async function archivedPollingChecks({ open, fixture, check }) {
  const { tab, context } = await open("/dashboard", { set: "freshLive=1&knocks=0", clock: true });
  try {
    await fixture("set?fail=home");
    await tab.getByRole("button", { name: "More actions for Q9 team" }).click();
    await tab.getByRole("menuitem", { name: "Archive call", exact: true }).click();
    await tab.getByText("Archived Q9 team", { exact: true }).waitFor();
    await tab.waitForTimeout(150);
    await tab.waitForLoadState("networkidle");
    const reads = async () => (await fixture("log")).filter((entry) => entry.path === "/dashboard-api/home-status").length;
    const before = await reads();
    await tab.clock.runFor(30000);
    await tab.waitForTimeout(150);
    await tab.waitForLoadState("networkidle");
    const after = await reads();
    check("Home stops polling an archived live row after its full refresh fails", (await tab.locator(".live").count()) === 0 && after === before, `status reads=${before}->${after}`);
  } finally {
    await context.close();
  }
}

// Accelerate browser time, not network replies: these drive the mounted pages and real hook.
export async function budgetChecks({ open, fixture, check, CALL }) {
  await reviewPollChecks({ open, fixture, check, CALL });
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
        const status = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-status"));
        const full = tick === 5 ? tab.waitForResponse((response) => new URL(response.url()).pathname === "/dashboard-api/call") : undefined;
        await tab.clock.runFor(5000);
        await status;
        await full;
        await tab.waitForLoadState("networkidle");
      }
      await tab.locator(".liveb").waitFor({ state: "hidden" });
      check("coalesced Episode refresh fetches the final ended state", refreshes.length === 3);
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
      await tab.clock.runFor(Math.ceil(Math.min(interval * 2, 30000) / interval) * interval);
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

export async function pollingBackoffChecks({ open, fixture, check, CALL }) {
  {
    const { tab, context } = await open("/dashboard", { set: "live=0", clock: true });
    try {
      await tab.route("**/dashboard-api/home", async (route) => {
        const response = await route.fetch();
        const page = await response.json();
        await route.fulfill({ response, json: { ...page, calls: page.calls.map((call, index) => (index === 0 ? { ...call, name: "Renamed elsewhere" } : call)) } });
      });
      await tab.evaluate(() => {
        for (const visibility of ["hidden", "visible"]) {
          Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      await tab.getByText("Renamed elsewhere", { exact: true }).waitFor();
      check("returning to idle Home revalidates the full list", true);
    } finally {
      await context.close();
    }
  }
  for (const status of [403, 404, 410]) {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=1", clock: true });
    try {
      await tab.route("**/dashboard-api/call-status?*", (route) => route.fulfill({ status, json: { error: { code: "access_lost" } } }));
      await tab.clock.runFor(3000);
      await tab.locator(".errp").waitFor({ state: "visible" });
      check(`terminal ${status} clears ready call and admission data`, (await tab.locator(".liveb,.orow").count()) === 0);
    } finally {
      await context.close();
    }
  }
  for (const retryAfter of ["60", "date", undefined]) {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=0", clock: true });
    try {
      let attempts = 0;
      let failing = true;
      const fullReads = async () => (await fixture("log")).filter((entry) => entry.path === "/dashboard-api/call").length;
      const initial = await fullReads();
      await tab.route("**/dashboard-api/call-status?*", async (route) => {
        attempts++;
        if (!failing) return route.continue();
        const headers = retryAfter === undefined ? {} : { "Retry-After": retryAfter === "date" ? await tab.evaluate(() => new Date(Date.now() + 60000).toUTCString()) : retryAfter };
        await route.fulfill({ status: retryAfter === undefined ? 503 : 429, headers, json: { error: { code: "fixture_failure" } } });
      });
      const advance = async (ms) => {
        await tab.clock.runFor(ms);
        await tab.waitForTimeout(150);
        await tab.waitForLoadState("networkidle");
      };
      await advance(5000);
      check(`polling retains ready data after ${retryAfter ?? "503"}`, attempts === 1 && (await tab.locator(".liveb").count()) === 1 && (await tab.locator('[aria-busy="true"],.errp').count()) === 0);
      if (retryAfter !== undefined) {
        await advance(30000);
        await tab.evaluate(() => {
          for (const visibility of ["hidden", "visible"]) {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: visibility });
            document.dispatchEvent(new Event("visibilitychange"));
          }
        });
        await advance(25000);
        check(`Retry-After ${retryAfter} suppresses polls and visibility bypass for 60 seconds`, attempts === 1);
        failing = false;
        await advance(5000);
        check(`Retry-After ${retryAfter} resumes at expiry`, attempts === 2);
      } else {
        for (const delay of [10000, 20000, 30000, 30000]) {
          const before = attempts;
          await advance(delay - 5000);
          check(`error backoff waits ${delay}ms at attempt ${before}`, attempts === before);
          await advance(5000);
          check(`error backoff retries after ${delay}ms at attempt ${before}`, attempts === before + 1);
        }
        failing = false;
        await advance(30000);
      }
      const recovered = attempts;
      await advance(5000);
      check(`successful ${retryAfter ?? "503"} recovery resets normal polling without full reads`, attempts === recovered + 1 && (await fullReads()) === initial);
      if (retryAfter === undefined) {
        failing = true;
        await advance(5000);
        const before = attempts;
        await advance(5000);
        check("success resets exponential error delay", attempts === before);
        await advance(5000);
        check("new failure restarts at ten seconds", attempts === before + 1);
      }
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=1", clock: true });
    try {
      const reads = async (path) => (await fixture("log")).filter((entry) => entry.path === `/dashboard-api/${path}`).length;
      const initial = await reads("call");
      const before = await reads("call-status");
      await tab.clock.runFor(3000);
      await tab.waitForLoadState("networkidle");
      check("pending knocks share the three-second status poll without full-page reads", (await reads("call-status")) === before + 1 && (await reads("call")) === initial);
    } finally {
      await context.close();
    }
  }
}

export async function reviewPollChecks({ open, fixture, check, CALL }) {
  const reads = async () => (await fixture("log")).filter((entry) => entry.method === "GET" && entry.path === "/dashboard-api/call").length;
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=0", clock: true });
    try {
      let missing = true;
      await tab.route("**/dashboard-api/call?*", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        await route.fulfill({ response, json: missing ? { ...data, live: null } : data });
        missing = false;
      });
      await tab.reload({ waitUntil: "networkidle" });
      const initial = await reads();
      await tab.clock.runFor(5000);
      await tab.waitForTimeout(150);
      await tab.waitForLoadState("networkidle");
      check("Call repairs a missing live snapshot despite matching Episode history", (await tab.locator(".liveb").count()) === 1 && (await reads()) === initial + 1);
    } finally {
      await context.close();
    }
  }
  {
    const { tab, context } = await open(CALL, { set: "freshLive=1&knocks=1", clock: true });
    try {
      const initial = await reads();
      await tab.getByRole("button", { name: "Deny", exact: true }).click();
      const settled = tab.waitForResponse((response) => response.url().includes("/dashboard-api/call-status"));
      await tab.clock.runFor(3000);
      await settled;
      await tab.locator(".orow").waitFor({ state: "hidden" });
      await tab.waitForTimeout(150);
      await tab.waitForLoadState("networkidle");
      check("Call knock decisions do not reload full history", (await reads()) === initial);
      await fixture("set?knocks=1");
      await tab.clock.runFor(5000);
      await tab.locator(".orow").waitFor({ state: "visible" });
      check("shared status polling resumes after a knock decision", (await reads()) === initial);
    } finally {
      await context.close();
    }
  }
}
