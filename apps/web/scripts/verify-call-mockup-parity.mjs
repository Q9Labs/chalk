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

  await page.goto(`${origin}/call-states.html?state=board-empty-dark`);
  const island = page.locator('.chalk-board-island[data-place="bottom"]');
  await island.waitFor();
  const islandTop = (await island.boundingBox()).y;
  // The toast stack is anchored by its bottom edge, so that edge is where the first toast sits.
  const toastBottom = await page.locator('[data-part="toast-stack"]').evaluate((stack) => stack.getBoundingClientRect().bottom);
  assert.ok(toastBottom <= islandTop - 8, `toasts sit above the board's tool island (toasts end at ${toastBottom}px, island starts at ${islandTop}px)`);

  console.log("PASS: rounded fields, toasts above the board island");
} finally {
  try {
    await browser?.close();
  } finally {
    await stop();
  }
}
