import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { showCallControls } from "./call-controls.mjs";

// The failure's logged state was data-idle=true. Advance only the browser clock
// past the SDK's three-second idle threshold; API/Sync credential clocks stay real.
const [kind, mode = "fixed", count = "50"] = process.argv.slice(2);
assert(["follow-pin", "owner-leave"].includes(kind));
assert(["baseline", "fixed"].includes(mode));
const iterations = Number(count);
assert(Number.isInteger(iterations) && iterations > 0);
let failures = 0;

async function clickAfterIdle(page, name) {
  await page.clock.fastForward(3100);
  await page.locator('[data-part="call-frame"][data-idle="true"]').waitFor();
  if (mode === "fixed") await showCallControls(page);
  try {
    await page.getByRole("button", { name, exact: true }).click({ timeout: 1000 });
    return true;
  } catch (error) {
    failures++;
    if (failures === 1) console.log(`FIRST_FAILURE ${error.message}`);
    return false;
  }
}

if (kind === "follow-pin") {
  const { startCallHarness } = await import("../src/call-states/browser-harness.ts");
  const { origin, stop } = await startCallHarness();
  const browser = await chromium.launch({ headless: true });
  try {
    for (let run = 0; run < iterations; run++) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        const [a, b] = await Promise.all([context.newPage(), context.newPage()]);
        for (const [page, self] of [
          [a, "a"],
          [b, "b"],
        ]) {
          await page.goto(`${origin}/call-states.html?state=integration-call`);
          await page.clock.install();
          await page.addScriptTag({ type: "module", url: `${origin}/src/call-states/follow-pin-fixture.tsx` });
          await page.evaluate(() => customElements.whenDefined("chalk-follow-pin-fixture"));
          await page.evaluate(({ self, room }) => document.createElement("chalk-follow-pin-fixture").mount(self, room), { self, room: `idle-${run}` });
          await page.getByRole("button", { name: `Video tile for ${self === "a" ? "Amina" : "Omar"}`, exact: true }).waitFor();
        }
        if (await clickAfterIdle(a, "Board")) await b.locator('.chalk-board-chip[role="status"]').filter({ hasText: "Following Amina" }).waitFor();
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await stop();
  }
} else {
  const { createDashboardProofFixture } = await import("./dashboard/browser-fixture.mjs");
  const { assertNoSeatCookies } = await import("./dashboard/owner-cookie-budget.mjs");
  const { context, origin, cleanup } = await createDashboardProofFixture({ devicesMissing: true });
  try {
    for (let run = 0; run < iterations; run++) {
      const page = await context.newPage();
      try {
        await page.clock.install();
        await page.goto(`${origin}/dashboard`);
        await page.getByRole("button", { name: "Start a call", exact: true }).click();
        await page.getByRole("button", { name: "Join call", exact: true }).click();
        await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
        const leave = page.getByRole("button", { name: "Leave call", exact: true });
        const opensMenu = (await leave.getAttribute("aria-haspopup")) === "menu";
        console.log(`OWNER_STATE run=${run} menu=${opensMenu}`);
        if (!(await clickAfterIdle(page, "Leave call"))) {
          // Restore the failed baseline's UI so each iteration releases its real seat.
          await showCallControls(page);
          await leave.click();
        }
        const response = page.waitForResponse(`${origin}/auth/clear-owner-seats`);
        await Promise.all([response.then((value) => assert.equal(value.status(), 200)), page.getByRole("menuitem", { name: "Leave call", exact: true }).click()]);
        await assertNoSeatCookies(context);
      } finally {
        await page.close();
      }
    }
  } finally {
    await cleanup();
  }
}
console.log(`IDLE_CONTROLS_PROOF ${JSON.stringify({ kind, mode, iterations, failures })}`);
assert.equal(failures, mode === "baseline" ? iterations : 0);
