import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { received, submit, checkGuestRegression } from "./report-support.mjs";

export async function guestReports(c) {
  const { browser, origin, call, evidence, regressions } = c;
  const guestContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const guest = await guestContext.newPage();
  let failureContext;
  let failurePage;
  const guestResponses = [];
  guest.on("response", (response) => guestResponses.push({ path: new URL(response.url()).pathname.replace(/[A-Za-z0-9_-]{32,}/g, "[opaque]"), status: response.status() }));
  try {
    const invite = new URL(call.inviteUrl);
    await guest.goto(`${origin}${invite.pathname}${invite.search}${invite.hash}`);
    await guest.getByLabel("Your name").fill("Report guest");
    await guest.getByRole("button", { name: "Join call", exact: true }).click();
    await guest.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    await guest.getByRole("button", { name: "Call details", exact: true }).first().click();
    await guest.getByRole("button", { name: "Keyboard shortcuts", exact: true }).waitFor();
    await guest.screenshot({ path: resolve(evidence, "guest-dropdown.png"), animations: "disabled" });
    await guest.getByRole("button", { name: "Report a problem", exact: true }).click();
    await submit(c, guest, { name: "guest", diagnostics: false });
    assert((await received(c)).at(-1).content.includes("Report guest (guest)"));
    await checkGuestRegression(c, "focus returns to mounted Call Details trigger", async () => {
      await guest.waitForFunction(() => document.activeElement?.matches('button[data-part="call-name"]'), undefined, { timeout: 3000 });
      assert(
        await guest
          .getByRole("button", { name: "Call details", exact: true })
          .first()
          .evaluate((element) => element.isConnected && element === document.activeElement),
      );
      await guest.screenshot({ path: resolve(evidence, "guest-focus-return.png"), animations: "disabled" });
    });
    await guest.mouse.move(500, 500);
    await guest.mouse.move(520, 500);
    if (process.env.CHALK_REPORT_SMOKE === "1") {
      await guest.getByRole("button", { name: "Leave call", exact: true }).click();
      await guest.getByRole("button", { name: "Report a problem", exact: true }).waitFor();
      assert.equal((await received(c)).length, 2, "Exactly one owner and one guest report");
      await writeFile(resolve(evidence, "browser-proof.json"), JSON.stringify({ result: "passed", reports: 2, paths: ["OwnerCall dropdown", "SpacePage dropdown"], mentions: "disabled", ordinaryWebhookProse: "accepted" }));
      return;
    }
    await guest.getByRole("button", { name: "Leave call", exact: true }).click();
    await guest.getByRole("button", { name: "Report a problem", exact: true }).waitFor();
    await guest.screenshot({ path: resolve(evidence, "left-link.png"), animations: "disabled" });
    await guest.getByRole("button", { name: "Report a problem", exact: true }).click();
    await submit(c, guest, { name: "left" });
    // Install the fault before this page creates any sockets. Keep API admission
    // and reporting real, but withhold Sync's hello so startup must time out.
    // A new context has no saved arrival to auto-resume before the name form.
    failureContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    failurePage = await failureContext.newPage();
    let interceptedSync = 0;
    await failurePage.routeWebSocket(/\/v1\/sync(?:\?|$)/, (socket) => {
      interceptedSync++;
      socket.onMessage(() => {});
    });
    await failurePage.goto(`${origin}${invite.pathname}${invite.search}${invite.hash}`);
    await failurePage.getByLabel("Your name").fill("Report failed guest");
    await failurePage.getByRole("button", { name: "Join call", exact: true }).click();
    await failurePage.getByText(/Could(?: not|n’t) connect to/).waitFor({ timeout: 45000 });
    assert(interceptedSync > 0, "The failed screen must follow an intercepted real Sync connection");
    await failurePage.getByRole("button", { name: "Report a problem", exact: true }).waitFor();
    await failurePage.screenshot({ path: resolve(evidence, "failed-link.png"), animations: "disabled" });
    await failurePage.getByRole("button", { name: "Report a problem", exact: true }).click();
    await submit(c, failurePage, { name: "failed" });
    await checkGuestRegression(c, "failed report retains captured terminal diagnostics", async () => {
      const content = (await received(c)).at(-1).content.replaceAll("\\", "");
      assert(content.includes("Connection: failed"), "Failed-call reports must retain the failed phase after client teardown");
      assert(content.includes("Last error: connection.sync_hello_timeout"), "Failed-call reports must retain the captured Sync failure");
    });

    await checkGuestRegression(c, "expired live guest hides the action and keeps an open draft", async () => {
      const expiryContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
      try {
        const expired = await expiryContext.newPage();
        await expired.clock.install();
        await expired.route("**/v1/public/space-invite-arrival/access-grants", (route) => route.fulfill({ status: 503, body: "{}" }));
        await expired.goto(`${origin}${invite.pathname}${invite.search}${invite.hash}`);
        await expired.getByLabel("Your name").fill("Report expiry guest");
        await expired.getByRole("button", { name: "Join call", exact: true }).click();
        await expired.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
        await expired.getByRole("button", { name: "Call details", exact: true }).first().click();
        await expired.getByRole("button", { name: "Report a problem", exact: true }).click();
        const input = expired.getByLabel("What went wrong?");
        await input.fill("Keep this guest draft after proof expiry");
        await input.evaluate((element) => (element.dataset.expiryDraft = "kept"));
        await expired.screenshot({ path: resolve(evidence, "guest-before-expiry.png"), animations: "disabled" });
        await expired.clock.fastForward(301_000);
        assert(await expired.locator('[data-tour="video-grid"]').first().isVisible(), "The guest call must stay live while access renewal is unavailable");
        assert(await expired.getByRole("button", { name: "Send", exact: true }).isDisabled());
        assert.equal(await input.inputValue(), "Keep this guest draft after proof expiry");
        assert.equal(await input.getAttribute("data-expiry-draft"), "kept", "The same draft field must remain mounted");
        await expired.screenshot({ path: resolve(evidence, "guest-after-expiry.png"), animations: "disabled" });
        await expired.getByRole("button", { name: "Cancel", exact: true }).click();
        await expired.clock.runFor(500);
        await expired.getByRole("button", { name: "Call details", exact: true }).first().press("Enter");
        await expired.getByRole("button", { name: "Keyboard shortcuts", exact: true }).waitFor();
        await expired.screenshot({ path: resolve(evidence, "guest-expired-menu.png"), animations: "disabled" });
        assert.equal(await expired.getByRole("button", { name: "Report a problem", exact: true }).count(), 0, "Expired live guests must not see a usable report action");
        await expired.setViewportSize({ width: 390, height: 844 });
        await expired.clock.runFor(500);
        await expired.getByRole("button", { name: "Keyboard shortcuts", exact: true }).waitFor();
        assert.equal(await expired.getByRole("button", { name: "Report a problem", exact: true }).count(), 0);
        await expired.screenshot({ path: resolve(evidence, "guest-expired-menu-phone.png"), animations: "disabled" });
        await expired.keyboard.press("Escape");
        await expired.clock.runFor(500);
        const left = expired.waitForResponse((response) => response.url().endsWith("/v1/public/space-invite-arrival") && response.request().method() === "DELETE");
        await expired.getByRole("button", { name: "Leave call", exact: true }).press("Enter");
        assert.equal((await left).status(), 204, "The expiry proof must release its extra live seat before closing the tab");
        await expired.getByRole("heading", { name: /You left/ }).waitFor();
      } finally {
        await expiryContext.close();
      }
    });
    assert(
      regressions.every(({ passed }) => passed),
      JSON.stringify(regressions),
    );
  } catch (error) {
    const failed = failurePage ?? guest;
    await failed.screenshot({ path: resolve(evidence, "guest-failure.png"), animations: "disabled" });
    await writeFile(resolve(evidence, "guest-failure.json"), JSON.stringify({ body: await failed.locator("body").innerText(), responses: guestResponses }));
    throw error;
  } finally {
    await failureContext?.close();
    await guestContext.close();
  }
}
