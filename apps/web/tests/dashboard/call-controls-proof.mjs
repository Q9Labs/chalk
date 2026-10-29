import { strict as assert } from "node:assert";
import { chromium } from "playwright";
import { showCallControls } from "../call-controls.mjs";

const [kind, mode = "fixed", count = "50"] = process.argv.slice(2);
assert(["follow-pin", "owner-menu"].includes(kind));
assert(["baseline", "fixed"].includes(mode));
const iterations = Number(count);
assert(Number.isInteger(iterations) && iterations > 0);
let failures = 0;
let samplesWithoutMenu = 0;

async function clickAfterIdle(page, name) {
  await page.clock.fastForward(3100);
  await page.locator('[data-part="call-frame"][data-idle="true"]').waitFor();
  if (mode === "fixed") await showCallControls(page);
  try {
    await page.getByRole("button", { name, exact: true }).click({ timeout: 1000 });
    return true;
  } catch (error) {
    assert.equal(await page.locator('[data-part="call-frame"]').getAttribute("data-idle"), "true");
    assert.match(error.message, /call-frame.*intercepts pointer events/);
    failures++;
    if (failures === 1) console.log(`FIRST_FAILURE ${error.message}`);
    return false;
  }
}

if (kind === "follow-pin") {
  const { startCallHarness } = await import("../../src/call-states/browser-harness.ts");
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
  const { createDashboardProofFixture } = await import("./browser-fixture.mjs");
  const { assertNoSeatCookies } = await import("./owner-cookie-budget.mjs");
  const { leaveOwnerCall } = await import("./owner-controls.mjs");
  const { context, origin, cleanup } = await createDashboardProofFixture({ devicesMissing: true });
  try {
    const setup = await context.newPage();
    await setup.goto(`${origin}/dashboard`);
    await setup.getByRole("button", { name: "Start a call", exact: true }).click();
    await setup.getByRole("button", { name: "Join call", exact: true }).waitFor();
    const joinURL = setup.url();
    await setup.close();
    // Re-enter the same call with a fresh tab and seat after each real UI Leave.
    for (let run = 0; run < iterations; run++) {
      const page = await context.newPage();
      try {
        await page.goto(joinURL);
        await page.getByRole("button", { name: "Join call", exact: true }).click();
        await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
        const leave = page.getByRole("button", { name: "Leave call", exact: true });
        const opensMenu = (await leave.getAttribute("aria-haspopup")) === "menu";
        if (!opensMenu) samplesWithoutMenu++;
        if (mode === "fixed") await leaveOwnerCall(page, origin);
        else {
          // Expose the observed race: capabilities arrive after the attribute
          // sample, while a browser action is still waiting to click the button.
          await page.locator('button[aria-label="Leave call"][aria-haspopup="menu"]').waitFor();
          await showCallControls(page);
          const [cleaned, clicked] = await Promise.allSettled([
            page.waitForResponse(`${origin}/auth/clear-owner-seats`, { timeout: 1000 }),
            (async () => {
              await leave.click();
              if (opensMenu) await page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
            })(),
          ]);
          if (clicked.status === "rejected") throw clicked.reason;
          if (cleaned.status === "rejected") {
            assert.equal(opensMenu, false);
            assert.match(cleaned.reason.message, /Timeout 1000ms/);
            await page.getByRole("menuitem", { name: "Leave call", exact: true }).waitFor();
            failures++;
            // Release the real seat after recording the baseline's missed action.
            await Promise.all([page.waitForResponse(`${origin}/auth/clear-owner-seats`).then((response) => assert.equal(response.status(), 200)), page.getByRole("menuitem", { name: "Leave call", exact: true }).click()]);
          } else assert.equal(cleaned.value.status(), 200);
        }
        await assertNoSeatCookies(context);
      } finally {
        await page.close();
      }
    }
  } finally {
    await cleanup();
  }
}
console.log(`CALL_CONTROLS_PROOF ${JSON.stringify({ kind, mode, iterations, failures, samplesWithoutMenu })}`);
if (mode === "fixed") assert.equal(failures, 0);
else if (kind === "follow-pin") assert.equal(failures, iterations);
else assert(failures > 0, "The baseline must reproduce a menu capability update between sampling and clicking");
