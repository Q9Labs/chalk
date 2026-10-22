import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { provePublicAdmission } from "./public-admission-browser.mjs";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

const { apiOrigin, origin, syncOrigin, repository, context, tenantId, bindings, syncLog, pagesLog, cleanup } = await createDashboardProofFixture();
let admissionGuestBrowser;
try {
  const page = await context.newPage();
  const sockets = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  try {
    await page.goto(`${origin}/dashboard`);
    await page.getByRole("button", { name: "Start a call", exact: true }).click();
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    assert(
      sockets.some((url) => url.startsWith(syncOrigin)),
      "Dashboard ignored its configured Sync endpoint",
    );
    assert(
      sockets.every((url) => new URL(url).hostname === "127.0.0.1"),
      "Dashboard contacted a non-local Sync endpoint",
    );
    await page.screenshot({ path: resolve(repository, "artifacts/dashboard-owner-in-call.png") });
    const spaceId = new URL(page.url()).pathname.split("/").at(-2);
    const joinUrl = page.url();
    async function leaveCall(tab) {
      await tab.getByRole("button", { name: "Leave call", exact: true }).click();
      await tab.getByRole("menuitem", { name: "Leave call", exact: true }).click();
      await tab.waitForURL(`${origin}/dashboard/call/${spaceId}`);
    }
    async function liveParticipants(expected) {
      let live;
      for (let attempt = 0; attempt < 100; attempt++) {
        const response = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/live-episodes?space_ids=${spaceId}`, { headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}` } });
        assert.equal(response.status, 200, await response.clone().text());
        live = (await response.json()).spaces[0]?.live_episode;
        if ((live?.participants.length ?? 0) === expected) return live;
        await delay(100);
      }
      assert.fail(`Expected ${expected} live seats, found ${live?.participants.length ?? 0}`);
    }
    const firstSeat = (await liveParticipants(1)).participants[0].participant_id;
    const callResponse = await context.request.get(`${origin}/dashboard-api/call?spaceId=${encodeURIComponent(spaceId)}`);
    assert.equal(callResponse.status(), 200, await callResponse.text());
    const call = await callResponse.json();
    assert.equal(new URL(call.inviteUrl).origin, apiOrigin, "Fixture must use an engine origin distinct from the dashboard");
    const readyLink = page.locator('[data-part="ready-link"]');
    await readyLink.waitFor({ state: "visible" });
    const displayed = await readyLink.innerText();
    assert(!displayed.includes("/dashboard/call/"), "In-call sharing exposed the owner-only dashboard join URL");
    assert(displayed.includes(call.inviteUrl.replace(/^https?:\/\//, "")), "In-call sharing did not display the engine canonical invite URL");
    await readyLink.getByRole("button", { name: "Copy link", exact: true }).click();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(copied, call.inviteUrl, "In-call copy must preserve the exact engine canonical invite URL");
    assert(!copied.includes("/dashboard/call/"));
    if (process.argv.some((argument) => argument.startsWith("--admission"))) {
      admissionGuestBrowser = await chromium.launch({ headless: true });
      await provePublicAdmission({ browser: admissionGuestBrowser, page, origin, apiOrigin, tenantId, spaceId, inviteUrl: call.inviteUrl, repository });
      if (await page.getByRole("button", { name: "Leave call", exact: true }).count()) await leaveCall(page);
      await liveParticipants(0);
    } else {
      const resumedAdmission = page.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "join");
      await page.reload();
      const admitted = await resumedAdmission;
      assert.equal(admitted.status(), 200, await admitted.text());
      assert.equal((await admitted.json()).access.subject.participant_id, firstSeat, "Reload admission must replay the original owner seat");
      await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
      const afterReload = await liveParticipants(1);
      assert.equal(afterReload.participants[0].participant_id, firstSeat, "Same-tab reload must resume the exact owner seat");
      const otherTab = await context.newPage();
      try {
        await otherTab.goto(joinUrl);
        await otherTab.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
        const independent = await liveParticipants(2);
        assert(
          independent.participants.some((participant) => participant.participant_id !== firstSeat),
          "A separate tab must get its own seat",
        );
        await leaveCall(otherTab);
        await liveParticipants(1);
      } finally {
        await otherTab.close();
      }
      // An already-written reload marker must not survive an intentional leave.
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide")));
      assert(await page.evaluate(() => sessionStorage.getItem("chalk.reload-rejoin")), "Pagehide must synchronously save the reload marker");
      await leaveCall(page);
      assert.equal(await page.evaluate(() => sessionStorage.getItem("chalk.reload-rejoin")), null, "Intentional leave clears the reload marker");
      await liveParticipants(0);
      await page.goto(joinUrl);
      await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
      const afterRejoin = await liveParticipants(1);
      assert.notEqual(afterRejoin.participants[0].participant_id, firstSeat, "Deliberate leave then rejoin must create a new owner seat");
      await leaveCall(page);
      await liveParticipants(0);
      console.log("PASS: real dashboard create → real Sync → canonical invite displayed/copied → reload resumes one exact owner seat → independent tab gets separate seat → leave clears roster → deliberate rejoin gets new seat → no orphan (devices denied)");
    }
  } catch (error) {
    await writeFile(resolve(repository, "artifacts/dashboard-join-failure.log"), JSON.stringify({ body: await page.locator("body").innerText(), sockets, sync: syncLog.join(""), pages: pagesLog.join("") }));
    throw error;
  }
} finally {
  await admissionGuestBrowser?.close();
  await cleanup();
}
