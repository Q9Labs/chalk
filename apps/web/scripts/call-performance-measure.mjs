import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { routeCallFixtureAssets } from "./call-fixture-routes.mjs";
import { newPage } from "./call-performance-page.mjs";
import { measuredPercentile, trustedInteractionMs } from "./call-performance-metrics.mjs";

/** One timed sample of a call scenario on one device. */

const ASSETS = ["script", "stylesheet"];

/** Collects load errors and the script and stylesheet responses the page made. */
function watchAssets(page) {
  const errors = [];
  const resources = new Map();
  page.on("requestfailed", (request) => {
    if (ASSETS.includes(request.resourceType())) errors.push(`${request.failure()?.errorText} ${request.url()}`);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (!ASSETS.includes(response.request().resourceType())) return;
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    resources.set(response.url(), response);
  });
  return { errors, resources };
}

async function openScenario(page, origin, scenario) {
  await page.goto(`${origin}/call-states.html?state=${scenario.state}`, { waitUntil: "load" });
  await page.getByRole("button", { name: "Leave call", exact: true }).waitFor();
  await page.waitForFunction(() => {
    return [...document.querySelectorAll("video")].some((video) => {
      const box = video.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.right > 0 && box.left < innerWidth && box.bottom > 0 && box.top < innerHeight && video.readyState >= 2 && video.videoWidth > 0;
    });
  });
  return page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now())))));
}

/** Starts the measured window: clears what the page counted while it loaded. */
async function startWindow(page) {
  await page.waitForTimeout(1000);
  await page.evaluate(() => Object.assign(window.__callPerf, { frames: [], tasks: [], events: [], start: performance.now(), last: null, clicks: 0, trustedInputs: [], layoutShift: 0, layoutShifts: [] }));
}

/** Makes every trusted click block the main thread for `busyMs`, to prove the budgets catch a slow click. */
function injectBusyClicks(page, busyMs) {
  return page.evaluate(
    (ms) =>
      document.addEventListener(
        "click",
        (event) => {
          if (!event.isTrusted) return;
          const end = performance.now() + ms;
          while (performance.now() < end) {}
        },
        true,
      ),
    busyMs,
  );
}

/** The few things a scenario does with the page: click a button, run a step outside the measured window, open and close chat. */
function actionsFor(page, device) {
  const click = async (name) => {
    const button = page.getByRole("button", { name, exact: true });
    try {
      if (device.touch) await button.tap({ timeout: 10_000 });
      else await button.click({ timeout: 10_000 });
    } catch (error) {
      const shown = await page.getByRole("button").evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim()));
      const sheets = await page.getByRole("dialog").evaluateAll((elements) => elements.map((element) => element.getAttribute("aria-label") ?? element.textContent?.slice(0, 40)));
      throw new Error(`Could not press ${String(name)}. Buttons on screen: ${JSON.stringify(shown)}. Dialogs: ${JSON.stringify(sheets)}.`, { cause: error });
    }
    await page.waitForTimeout(350);
  };
  const outsideSample = async (action) => {
    const before = await page.evaluate(() => {
      window.__callPerf.navigationWindows.push({ start: performance.now(), end: Infinity });
      window.__callPerf.last = null;
      return window.__callVideoQuality.snapshot();
    });
    try {
      await action();
    } finally {
      await page.evaluate((before) => {
        const after = window.__callVideoQuality.snapshot();
        for (const metric of ["frames", "dropped", "resets", "samples"]) window.__callPerf.navigationVideoQuality[metric] += after[metric] - before[metric];
        window.__callPerf.navigationWindows.at(-1).end = performance.now();
        window.__callPerf.last = null;
      }, before);
    }
  };
  const visitChat = async () => {
    await click("Chat");
    await page.getByRole("complementary", { name: "Chat panel" }).waitFor();
    await click("Close panel");
    await page.getByRole("complementary", { name: "Chat panel" }).waitFor({ state: "hidden" });
  };
  return { page, device, click, outsideSample, visitChat };
}

async function panelsStep({ page, device, click, outsideSample, visitChat }) {
  const openPhoneNavigation = async () => {
    if (device.touch) await outsideSample(() => click("More options"));
  };
  await openPhoneNavigation();
  await visitChat();
  await openPhoneNavigation();
  await click(device.touch ? "People" : /^People, \d+$/);
  await page.getByRole("button", { name: "Close panel", exact: true }).waitFor();
  await click("Close panel");
}

async function boardStep({ page }) {
  const canvas = page.locator(".excalidraw canvas").first();
  await canvas.waitFor({ state: "visible", timeout: 30_000 });
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 40, { steps: 12 });
  await page.mouse.up();
}

async function reactionsStep({ page }) {
  await page.locator("[data-perf-reactions]").dispatchEvent("click");
  await page.waitForFunction(() => document.body.textContent.includes("🎉"));
}

async function reconnectStep({ page, device, click, outsideSample, visitChat }) {
  await page.locator("[data-perf-reconnect]").dispatchEvent("click");
  const notice = page.locator('[data-part="connection-status"]');
  await notice.filter({ hasText: "Reconnecting" }).waitFor({ timeout: 10_000 });
  const noticePointerEvents = await notice.evaluate((element) => `${getComputedStyle(element).pointerEvents} on ${element.className} ${element.getAttribute("role")}`);
  if (!noticePointerEvents.startsWith("none ")) throw new Error(`Recovery notice intercepts call controls: ${noticePointerEvents}`);
  if (await page.locator('[data-call-limbo][data-covered="true"][aria-hidden="false"]').count()) throw new Error("Recovery covers the call");
  // Check recovery usability without turning this connection sample into a panel-navigation benchmark.
  await outsideSample(async () => {
    await page.mouse.move(device.viewport.width / 2, device.viewport.height / 2);
    // Sheets close under the recovery card, so a phone has no Chat to reach until the call returns.
    if (!device.touch) await visitChat();
  });
  await page.waitForTimeout(350);
  await page.locator("[data-perf-recover]").dispatchEvent("click");
  await notice.waitFor({ state: "hidden", timeout: 10_000 });
  await page.mouse.move(device.viewport.width / 2, device.viewport.height / 2);
  await page.getByRole("button", { name: "Leave call", exact: true }).click({ trial: true });
}

const STEPS = { panels: panelsStep, board: boardStep, reactions: reactionsStep, reconnect: reconnectStep };

function readWindow(page) {
  return page.evaluate(() => ({
    ...window.__callPerf,
    videoQuality: Object.fromEntries(Object.entries(window.__callVideoQuality.snapshot()).map(([metric, value]) => [metric, value - window.__callPerf.navigationVideoQuality[metric]])),
    supported: PerformanceObserver.supportedEntryTypes,
    durationMs: performance.now() - window.__callPerf.start - window.__callPerf.navigationWindows.reduce((total, { start, end }) => total + end - start, 0),
    videos: [...document.querySelectorAll("video")].map((video) => ({ paused: video.paused, readyState: video.readyState, frames: video.getVideoPlaybackQuality().totalVideoFrames, droppedFrames: video.getVideoPlaybackQuality().droppedVideoFrames })),
  }));
}

function checkObserved(data, scenario, bundleOnly) {
  if (!bundleOnly && (!data.supported.includes("event") || !data.supported.includes("longtask") || data.frames.length < 2)) throw new Error(`Missing performance observations for ${scenario.id}: ${JSON.stringify(data)}`);
  if (scenario.id === "panels" && data.clicks !== 4) throw new Error(`Expected four trusted panel clicks, got ${data.clicks}`);
}

/** Gzipped size of what the page loaded, split into script and stylesheet. */
async function loadedSizes(resources, origin) {
  let jsGzipKiB = 0;
  let cssGzipKiB = 0;
  const loaded = [];
  for (const [url, response] of resources) {
    const size = gzipSync(await response.body(), { level: 9 }).length / 1024;
    if (response.request().resourceType() === "script") jsGzipKiB += size;
    else cssGzipKiB += size;
    loaded.push({ url: url.replace(origin, ""), gzipKiB: size });
  }
  return { jsGzipKiB, cssGzipKiB, loaded };
}

function frameStats(frames) {
  const missed = frames.reduce((sum, ms) => sum + Math.max(0, Math.round(ms / (1000 / 60)) - 1), 0);
  return { frameP95Ms: frames.length ? measuredPercentile(frames, 0.95) : null, droppedFramePercent: frames.length ? (100 * missed) / (missed + frames.length) : null };
}

function droppedVideoPercent({ frames, dropped }) {
  if (frames) return (100 * dropped) / frames;
  return dropped ? 100 : 0;
}

async function saveFailure(page, root) {
  await mkdir(resolve(root, "artifacts"), { recursive: true });
  await page.screenshot({ path: resolve(root, "artifacts/performance-failure.png"), timeout: 5000 });
  await writeFile(resolve(root, "artifacts/performance-failure.html"), await page.content());
}

async function saveShot(page, directory, name) {
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: resolve(directory, `${name}.png`) });
}

/** `session` is `{ browser, origin, root, values }`: the shared browser, the served build, the repo root and the parsed command line. */
export async function measure(session, device, scenario, { inject = false, pauseVideo = false, capture = null } = {}) {
  const { browser, origin, root, values } = session;
  const { context, page, cdp } = await newPage(browser, device);
  const { errors, resources } = watchAssets(page);
  const boardCss = resolve(root, "packages/whiteboard/node_modules/@excalidraw/excalidraw/dist/prod/index.css");
  await routeCallFixtureAssets(page, boardCss);
  try {
    await stat(boardCss);
    const firstCallMs = await openScenario(page, origin, scenario);
    if (pauseVideo) await page.evaluate(() => document.querySelectorAll("video").forEach((video) => video.pause()));
    if (scenario.id !== "first-load") await startWindow(page);
    await page.evaluate(() => {
      window.__callVideoQuality.reset();
    });
    if (inject) await injectBusyClicks(page, inject);
    await STEPS[scenario.id]?.(actionsFor(page, device));
    await page.waitForTimeout(session.sampleMs);
    const data = await readWindow(page);
    checkObserved(data, scenario, values["bundle-only"]);
    const trustedEvents = data.events.filter((entry) => data.trustedInputs.some((input) => input.name === entry.name && Math.abs(input.at - entry.startTime) < 1));
    const metrics = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    const dom = await cdp.send("Memory.getDOMCounters");
    const sizes = await loadedSizes(resources, origin);
    if (errors.length) throw new Error(`${scenario.id}: ${errors.join("; ")}`);
    if (capture && values.shots) await saveShot(page, resolve(root, values.shots), capture);
    return {
      layoutShift: data.layoutShift,
      layoutShifts: data.layoutShifts,
      videoDroppedFramePercent: droppedVideoPercent(data.videoQuality),
      videoQuality: data.videoQuality,
      ...frameStats(data.frames),
      longTasks: data.tasks.length,
      blockingMs: data.tasks.reduce((sum, ms) => sum + Math.max(0, ms - 50), 0),
      interactionMs: trustedInteractionMs(data.events, data.trustedInputs),
      heapMiB: metrics.JSHeapUsedSize / 1024 ** 2,
      domNodes: dom.nodes,
      ...(scenario.id === "first-load" ? { firstCallMs } : {}),
      jsGzipKiB: sizes.jsGzipKiB,
      cssGzipKiB: sizes.cssGzipKiB,
      durationMs: data.durationMs,
      ...(data.navigationWindows.length ? { excludedNavigationWindows: data.navigationWindows } : {}),
      frameSamples: data.frames.length,
      trustedClicks: data.clicks,
      eventEntries: trustedEvents.length,
      eventTimings: trustedEvents,
      inputTimings: data.trustedInputs,
      rawEventTimings: data.events,
      videos: data.videos,
      loaded: sizes.loaded,
    };
  } catch (error) {
    await saveFailure(page, root);
    throw error;
  } finally {
    await context.close();
  }
}
