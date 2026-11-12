import { installVideoQualityObserver, videoCounterDelta } from "./call-video-quality.mjs";
import { measuredPercentile } from "./call-performance-metrics.mjs";

/** The browser side of a performance sample: the observers a page runs, a throttled page to drive, and a check that the frame clock is usable. */

function installObservers() {
  const data = { frames: [], tasks: [], events: [], start: performance.now(), last: null, clicks: 0, trustedInputs: [], layoutShift: 0, layoutShifts: [], navigationWindows: [], navigationVideoQuality: { frames: 0, dropped: 0, resets: 0, samples: 0 } };
  const measured = (at) => at >= data.start && !data.navigationWindows.some(({ start, end }) => at >= start && at < end);
  window.__callPerf = data;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (measured(entry.startTime)) {
        data.layoutShift += entry.value;
        data.layoutShifts.push({
          value: entry.value,
          startTime: entry.startTime,
          hadRecentInput: entry.hadRecentInput,
          sources: (entry.sources ?? []).map((source) => ({ tag: source.node?.nodeName, class: source.node?.getAttribute?.("class")?.slice(0, 160), previousRect: source.previousRect.toJSON(), currentRect: source.currentRect.toJSON() })),
        });
      }
  }).observe({ type: "layout-shift", buffered: true });
  const frame = (at) => {
    if (measured(at)) {
      if (data.last !== null) data.frames.push(at - data.last);
      data.last = at;
    } else data.last = null;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (measured(entry.startTime)) data.tasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: true });
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (measured(entry.startTime) && entry.interactionId) data.events.push({ startTime: entry.startTime, duration: entry.duration, name: entry.name, interactionId: entry.interactionId });
  }).observe({ type: "event", buffered: true, durationThreshold: 16 });
  for (const name of ["pointerdown", "pointerup", "click"]) {
    document.addEventListener(
      name,
      (event) => {
        if (!event.isTrusted || !measured(event.timeStamp)) return;
        data.trustedInputs.push({ name: event.type, at: event.timeStamp });
        if (event.type === "click") data.clicks++;
      },
      true,
    );
  }
}
export async function newPage(browser, device) {
  const context = await browser.newContext({ viewport: device.viewport, hasTouch: device.touch, isMobile: device.touch, deviceScaleFactor: 1, reducedMotion: "no-preference", serviceWorkers: "block" });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: device.cpu });
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await page.addInitScript(installObservers);
  await page.addInitScript({ content: `(${installVideoQualityObserver.toString()})(${videoCounterDelta.toString()})` });
  return { context, page, cdp };
}
export async function calibrate(browser, device) {
  const { context, page } = await newPage(browser, device);
  try {
    await page.goto("about:blank");
    await page.evaluate(installObservers);
    await page.waitForTimeout(1200);
    const frames = await page.evaluate(() => window.__callPerf.frames);
    return { frameMedianMs: measuredPercentile(frames, 0.5), frameP95Ms: measuredPercentile(frames, 0.95), samples: frames.length };
  } finally {
    await context.close();
  }
}
