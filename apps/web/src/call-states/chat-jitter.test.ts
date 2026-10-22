import { mkdir, writeFile } from "node:fs/promises";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";

let origin: string;
let stop: (() => Promise<void>) | undefined;
let browser: Browser;
beforeAll(async () => {
  ({ origin, stop } = await startCallHarness());
  browser = await chromium.launch({ channel: "chromium", headless: true });
}, 60_000);
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await stop?.();
  }
});

async function openChat(page: Page, width: number) {
  await page.goto(`${origin}/call-states.html?state=chat-jitter`);
  if (width === 390) {
    await page.getByRole("button", { name: "More options", exact: true }).click();
    await page.getByRole("dialog", { name: "More options", exact: true }).getByRole("button", { name: "People", exact: true }).click();
    await page.getByRole("tab", { name: "Chat", exact: true }).click();
  } else {
    await page.getByRole("button", { name: "Chat", exact: true }).click();
  }
  const list = page.getByLabel("Chat messages", { exact: true });
  await list.waitFor();
  await page.waitForTimeout(1500);
  return list;
}

for (const width of [1440, 390]) {
  it(`keeps idle chat messages still across call clock ticks at ${width}px`, async () => {
    const artifacts = process.env.CHAT_JITTER_ARTIFACTS;
    const directory = artifacts ? `${artifacts}/${width}` : undefined;
    if (directory) await mkdir(directory, { recursive: true });
    const viewport = { width, height: width === 390 ? 844 : 900 };
    const context = await browser.newContext({ viewport, isMobile: width === 390, hasTouch: width === 390, ...(directory ? { recordVideo: { dir: directory, size: viewport } } : {}) });
    try {
      const page = await context.newPage();
      const list = await openChat(page, width);
      const duration = directory ? 10_000 : 3500;
      const clock = page.locator('[data-part="call-timer"]').first();
      const before = await clock.textContent();
      const positions = list.evaluate(async (element, milliseconds) => {
        const anchor = element.querySelector('[data-chat-sequence="11"]');
        if (!anchor) throw new Error("Last chat message is missing");
        const samples: { time: number; y: number; scrollTop: number; scrollHeight: number; height: number }[] = [];
        const start = performance.now();
        await new Promise<void>((resolve) => {
          const sample = () => {
            samples.push({ time: performance.now() - start, y: anchor.getBoundingClientRect().y, scrollTop: element.scrollTop, scrollHeight: element.scrollHeight, height: element.clientHeight });
            if (performance.now() - start >= milliseconds) resolve();
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        return samples;
      }, duration);
      const samples = await positions;
      if (directory) {
        await writeFile(`${directory}/positions.json`, JSON.stringify(samples));
        await writeFile(`${directory}/clip.json`, JSON.stringify(await list.boundingBox()));
        await page.screenshot({ path: `${directory}/screen.png` });
      }
      expect(await clock.textContent()).not.toBe(before);
      expect(samples.length).toBeGreaterThanOrEqual(duration / 100);
      const ys = samples.map((sample) => sample.y);
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  }, 60_000);
  it(`keeps following closely spaced incoming messages at ${width}px`, async () => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, isMobile: width === 390, hasTouch: width === 390 });
    try {
      const page = await context.newPage();
      const list = await openChat(page, width);
      await page.evaluate(() => window.dispatchEvent(new Event("chat-jitter-incoming")));
      await page.waitForTimeout(150);
      await page.evaluate(() => window.dispatchEvent(new Event("chat-jitter-incoming")));
      await page.waitForTimeout(1000);
      expect(await list.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(1);
    } finally {
      await context.close();
    }
  }, 30_000);
}
