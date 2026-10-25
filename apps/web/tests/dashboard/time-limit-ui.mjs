import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { startCallHarness } from "../../src/call-states/browser-harness.ts";
const { origin, stop } = await startCallHarness();
const output = process.env.TIME_LIMIT_EVIDENCE || resolve("../../scratchpad/time-limit-warnings-evidence");
await mkdir(output, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const before = process.env.TIME_LIMIT_BEFORE === "1";
  for (const [device, viewport] of [
    ["laptop", { width: 1440, height: 900 }],
    ["phone", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    for (const state of before ? ["duo", "episode-ended"] : ["time-limit-amber", "time-limit-red", "time-limit-anonymous", "time-limit-guest", "time-limit-owner-ended", "time-limit-anonymous-ended", "time-limit-guest-ended"]) {
      await page.goto(`${origin}/call-states.html?state=${state}`);
      await page.locator((before && state === "episode-ended") || state.endsWith("-ended") ? "[data-chalk-status]" : '[data-part="call-frame"]').waitFor();
      if (!before) {
        if (state.endsWith("-ended")) {
          await page.getByRole("heading", { name: "The call reached its time limit" }).waitFor();
          assert.equal(await page.getByRole("button", { name: "Start a new call", exact: true }).count(), state.includes("owner") ? 1 : 0);
          assert.equal(await page.getByRole("button", { name: "Sign up free", exact: true }).count(), state.includes("anonymous") ? 1 : 0);
          await page.getByRole("button", { name: "Home", exact: true }).waitFor();
        } else {
          const timer = page.locator('[data-part="call-timer"]').filter({ visible: true });
          await timer.filter({ hasText: "left" }).waitFor();
          const color = await timer.evaluate((element) => getComputedStyle(element).color);
          const targetColor = await timer.evaluate((element, red) => {
            const sample = document.createElement("span");
            sample.style.color = red ? "var(--chalk-danger-text)" : "var(--chalk-warning, #dcb740)";
            element.append(sample);
            const value = getComputedStyle(sample).color;
            sample.remove();
            return value;
          }, state === "time-limit-red");
          assert.equal(color, targetColor);
          await page
            .locator('[data-part="toast"]')
            .filter({ hasText: state === "time-limit-red" ? "1 minute left" : "10 minutes left" })
            .waitFor();
        }
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(output, `${before ? "before" : "after"}-${state}-${device}.png`) });
    }
  }
  if (!before) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/call-states.html?state=time-limit-amber`);
    await page.getByRole("button", { name: "Add 30 min", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[data-part="call-timer"]')?.textContent.includes("left"));
    for (const [seconds, minutes] of [
      [600, 10],
      [300, 5],
      [60, 1],
    ]) {
      await page.locator("[data-time-left]").evaluate((button, seconds) => {
        button.dataset.seconds = String(seconds);
        button.click();
      }, seconds);
      await page
        .locator('[data-part="toast"]')
        .filter({ hasText: `${minutes} ${minutes === 1 ? "minute" : "minutes"} left` })
        .waitFor();
    }
    await page.goto(`${origin}/call-states.html?state=time-limit-anonymous`);
    await page.getByRole("button", { name: "Sign up free", exact: true }).click();
    assert.equal(new URL(page.url()).pathname, "/dashboard/sign-in");
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${before ? "baseline screenshots" : "header colors, warning thresholds, extension re-arm, role end pages, signup navigation"}: ${output}`);
} finally {
  await browser?.close();
  await stop();
}
