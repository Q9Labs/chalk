import { randomUUID } from "node:crypto";
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Only the advertised expiry is shortened. Admission, renewal, signed proofs,
// the call ending and report delivery still use the real local API and Sync.
export async function checkReportTransitions({ browser, page, origin, call, csrfToken, evidence }) {
  const results = [];
  async function check(name, run) {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
    await writeFile(resolve(evidence, "report-transitions.json"), JSON.stringify(results, null, 2));
  }

  for (const dismissal of ["Close", "Escape"]) {
    const ownerContext = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 1440, height: 960 } });
    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const owner = await ownerContext.newPage();
      const guest = await guestContext.newPage();
      await owner.goto(`${origin}/dashboard`);
      await owner.getByRole("button", { name: "Start a call", exact: true }).click();
      await owner.getByRole("button", { name: "Join call", exact: true }).click();
      await owner.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
      const spaceId = new URL(owner.url()).pathname.split("/").at(-2);
      const read = await ownerContext.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`);
      assert.equal(read.status(), 200);
      const separateCall = await read.json();
      const open = await ownerContext.request.post(`${origin}/dashboard-api/call`, { headers: { Origin: origin, "X-CSRF-Token": csrfToken }, data: { action: "set-admission", spaceId, admission: "anyone" } });
      assert.equal(open.status(), 200);
      const invite = new URL(separateCall.inviteUrl);
      await guest.goto(`${origin}${invite.pathname}${invite.search}${invite.hash}`);
      await guest.getByLabel("Your name").fill("Draft participant");
      await guest.getByRole("button", { name: "Join call", exact: true }).click();
      await guest.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
      const drafts = [];
      for (const [role, tab] of [
        ["owner", owner],
        ["guest", guest],
      ]) {
        await tab.getByRole("button", { name: "Call details", exact: true }).first().click();
        await tab.getByRole("button", { name: "Report a problem", exact: true }).click();
        const input = tab.getByLabel("What went wrong?");
        const text = `Keep this ${role} live report draft through ${dismissal}`;
        await input.fill(text);
        drafts.push({ role, tab, text, input: await input.elementHandle() });
      }
      const end = await ownerContext.request.post(`${origin}/dashboard-api/call`, { headers: { Origin: origin, "X-CSRF-Token": csrfToken }, data: { action: "end-for-everyone", spaceId, episodeId: separateCall.live.id, idempotencyKey: randomUUID() } });
      assert.equal(end.status(), 200, await end.text());
      for (const { role, tab, text, input } of drafts) {
        await check(`${role}: ${dismissal} after Episode end focuses the mounted terminal control`, async () => {
          await tab.getByText("The call ended", { exact: true }).waitFor();
          assert(await input.evaluate((element) => element.isConnected), `${role} textarea must remain mounted`);
          assert.equal(await tab.getByLabel("What went wrong?").inputValue(), text);
          if (dismissal === "Escape") await tab.keyboard.press("Escape");
          else await tab.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
          await tab.getByRole("dialog").waitFor({ state: "hidden" });
          const focused = await tab.getByRole("button", { name: "Home", exact: true }).evaluate((element) => element.isConnected && element === document.activeElement);
          await tab.screenshot({ path: resolve(evidence, `ended-${role}-${dismissal}.png`), animations: "disabled" });
          assert(focused, `${role} ${dismissal} must return focus to Home, not BODY or the removed Call Details`);
        });
      }
    } finally {
      await guestContext.close();
      await ownerContext.close();
    }
  }

  await check("guest: renewal retains the mounted draft and restores successful sending", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const renewal = Promise.withResolvers();
    try {
      const guest = await context.newPage();
      await guest.clock.install();
      let shortened = false;
      await guest.route("**/v1/public/space-invite-arrivals", async (route) => {
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        const arrival = await response.json();
        assert(arrival.access?.media && arrival.access?.sync, "Real admission must include access");
        const expiresAt = new Date(Date.now() + 90_000).toISOString();
        arrival.access.media.expires_at = expiresAt;
        arrival.access.sync.expires_at = expiresAt;
        shortened = true;
        await route.fulfill({ response, json: arrival });
      });
      await guest.route("**/v1/public/space-invite-arrival/access-grants", async (route) => {
        await renewal.promise;
        await route.continue();
      });
      const invite = new URL(call.inviteUrl);
      await guest.goto(`${origin}${invite.pathname}${invite.search}${invite.hash}`);
      await guest.getByLabel("Your name").fill("Report renewal guest");
      await guest.getByRole("button", { name: "Join call", exact: true }).click();
      await guest.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
      assert(shortened, "The deterministic expiry fixture must run");
      await guest.getByRole("button", { name: "Call details", exact: true }).first().click();
      await guest.getByRole("button", { name: "Report a problem", exact: true }).click();
      const draft = guest.getByLabel("What went wrong?");
      const input = await draft.elementHandle();
      const text = "Keep this draft across expiry and real access renewal";
      await draft.fill(text);
      const refreshing = guest.waitForRequest((request) => request.url().endsWith("/access-grants"));
      await guest.clock.fastForward(91_000);
      await refreshing;
      await guest.clock.runFor(50);
      assert(await guest.getByRole("button", { name: "Send", exact: true }).isDisabled(), "Expired proof must disable Send");
      assert.equal(await draft.inputValue(), text);
      await guest.screenshot({ path: resolve(evidence, "renewal-expired-draft.png"), animations: "disabled" });
      const renewed = guest.waitForResponse((response) => response.url().endsWith("/access-grants"));
      renewal.resolve();
      const renewalResponse = await renewed;
      assert.equal(renewalResponse.status(), 201, "The real API must issue a renewed access grant");
      const renewedAccess = await renewalResponse.json();
      await guest.clock.runFor(50);
      assert(await input.evaluate((element) => element.isConnected), "Renewal must keep the same textarea mounted");
      assert.equal(await draft.inputValue(), text);
      assert(await guest.getByRole("button", { name: "Send", exact: true }).isEnabled());
      await guest.screenshot({ path: resolve(evidence, "renewal-restored-draft.png"), animations: "disabled" });
      const delivery = guest.waitForResponse((response) => response.url().endsWith("/problem-reports") && response.request().method() === "POST");
      await guest.getByRole("button", { name: "Send", exact: true }).click();
      const delivered = await delivery;
      assert.equal(delivered.status(), 200, "The preserved draft must send with the renewed real proof to fake Discord");
      assert((await delivered.request().headerValue("authorization")) === `Bearer ${renewedAccess.media.token}`, "Send must use the renewed proof");
      assert.equal(delivered.request().postDataJSON().description, text, "Send must carry the unchanged draft");
      await guest.getByRole("button", { name: "Done", exact: true }).click();
      await guest.clock.runFor(500);
      const left = guest.waitForResponse((response) => response.url().endsWith("/v1/public/space-invite-arrival") && response.request().method() === "DELETE");
      await guest.getByRole("button", { name: "Leave call", exact: true }).press("Enter");
      assert.equal((await left).status(), 204);
    } finally {
      renewal.resolve();
      await context.close();
    }
  });
  assert(
    results.every(({ passed }) => passed),
    JSON.stringify(results),
  );
}
