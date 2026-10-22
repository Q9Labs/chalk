import { strict as assert } from "node:assert";
import { startCallHarness } from "../src/call-states/browser-harness.ts";
import { chromium } from "playwright";

// Layout facts from the approved call and board mockups that only a real browser can measure.
const { origin, stop } = await startCallHarness();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${origin}/call-states.html?state=name-needed`);
  const name = page.locator("#join-display-name");
  await name.waitFor();
  // Tailwind's radius scale once read a --radius token that no stylesheet defined, so every rounded-* rendered square.
  assert.equal(await name.evaluate((input) => getComputedStyle(input).borderRadius), "12px", "the name field keeps the 12px field radius");

  for (const viewport of [{ width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/call-states.html?state=board-empty-dark`);
    const zoom = page.locator(".chalk-board-zoom");
    await zoom.waitFor();
    // The island docks at the bottom of the stage, in the same row as the zoom control.
    const controlsTop = Math.min(...(await page.locator(".chalk-board-island, .chalk-board-zoom").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))));
    // The toast stack is anchored by its bottom edge, so that edge is where the first toast sits.
    const toastBottom = await page.locator('[data-part="toast-stack"]').evaluate((stack) => stack.getBoundingClientRect().bottom);
    assert.ok(toastBottom <= controlsTop - 8, `at ${viewport.width}px, toasts sit above the board's bottom controls (toasts end at ${toastBottom}px, controls start at ${controlsTop}px)`);
  }

  // A past-session recording smaller than the 16:9 player kept its own size in the corner. A video without a source is 300x150.
  await page.setContent(`<link rel="stylesheet" href="${origin}/src/styles/dashboard.css"><div class="site"><div class="dash"><div class="player" style="width: 960px"><video></video></div></div></div>`, { waitUntil: "load" });
  const [player, video] = await Promise.all([".player", ".player video"].map((selector) => page.locator(selector).evaluate((element) => [element.getBoundingClientRect().width, element.getBoundingClientRect().height])));
  assert.deepEqual(video, player, `the recording fills the 16:9 player (video ${video}, player ${player})`);

  console.log("PASS: rounded fields, toasts above the board island, recordings fill the player");
} finally {
  try {
    await browser?.close();
  } finally {
    await stop();
  }
}
