import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

// Called by the real-engine + dashboard join harness. Nothing substitutes the
// app, API, signed call credentials, database, or Sync; only Discord is local.
export async function checkReports({ browser, page, origin, call, repository }) {
  const evidence = resolve(repository, "artifacts/report-discord");
  await mkdir(evidence, { recursive: true });
  const regressions = [];
  async function checkGuestRegression(name, check) {
    try {
      await check();
      regressions.push({ name, passed: true });
    } catch (error) {
      regressions.push({ name, passed: false, error: String(error) });
    }
    await writeFile(resolve(evidence, "guest-regressions.json"), JSON.stringify(regressions, null, 2));
  }
  const home = await page.context().newPage();
  try {
    await home.goto(`${origin}/dashboard`);
    await home.getByRole("button", { name: `More actions for ${call.call.name}`, exact: true }).click();
    await home.getByRole("menuitem", { name: "Rename", exact: true }).click();
    const input = home.getByRole("dialog").getByLabel("Name", { exact: true });
    const name = "🎥".repeat(119) + "🏁";
    await input.fill(name);
    await home.screenshot({ path: resolve(evidence, "unicode-name-input.png"), animations: "disabled" });
    assert.equal(await input.inputValue(), name, "The dashboard must preserve a 120-code-point emoji name and its suffix");
    await input.fill(name + "extra");
    assert.equal(await input.inputValue(), name, "The input must cap by code points, without losing its suffix");
    await input.fill("extra" + name);
    assert.equal(await input.inputValue(), name, "An insertion at the limit must not discard the identifying suffix");
    const saved = home.waitForResponse((response) => response.url().endsWith("/dashboard-api/home") && response.request().method() === "POST");
    await home.getByRole("button", { name: "Save name", exact: true }).click();
    const response = await saved;
    assert.equal(response.status(), 200);
    const renamed = await response.json();
    assert.equal(renamed.call.name, name, "Dashboard and API must accept the complete supported name");
    await home.getByRole("dialog").waitFor({ state: "hidden" });
    call.call.name = name;
  } finally {
    await home.close();
  }
  const video = page.video();
  if (video) await writeFile(resolve(evidence, "owner-video-name.txt"), basename(await video.path()));
  const label = process.env.CHALK_REPORT_LIVE_PROOF === "1" ? "TEST from Chalk report-discord PR, ignore" : "Report browser proof";
  const webhook = process.env.CHALK_REPORT_FAKE_ORIGIN;
  assert(webhook, "Run with report-proof.mjs");
  async function received() {
    return (await fetch(`${webhook}/reports`)).json();
  }
  function deliveryRecords() {
    return JSON.parse(
      execFileSync(
        "psql",
        [
          process.env.CHALK_DATABASE_URL,
          "-v",
          "ON_ERROR_STOP=1",
          "-Atqc",
          "select coalesce(json_agg(json_build_object('event_id',event_id,'journey_id',journey_id,'name',name,'state',state,'attributes',attributes)), '[]'::json) from observability_journey_events where name='problem_report.delivered'",
        ],
        { encoding: "utf8" },
      ),
    );
  }
  async function submit(tab, { name, diagnostics = true, failure = false }) {
    const dialog = tab.getByRole("dialog").filter({ has: tab.getByText("What went wrong?", { exact: true }) });
    const description = `${label}: ${name}. I looked at discord.com/api/webhooks but the camera still froze. @everyone`;
    await dialog.getByLabel("What went wrong?").fill(description);
    assert.equal(await dialog.getByLabel("Include diagnostics").isChecked(), false, "Diagnostics must be opt-in");
    if (diagnostics) await dialog.getByLabel("Include diagnostics").check();
    await tab.screenshot({ path: resolve(evidence, `${name}-form.png`), animations: "disabled" });
    const previousIds = new Set(deliveryRecords().map((event) => event.event_id));
    if (failure) assert.equal((await fetch(`${webhook}/fail`, { method: "POST" })).status, 204);
    const delivery = tab.waitForResponse((response) => response.url().endsWith("/problem-reports") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Send", exact: true }).click();
    await dialog.getByRole("button", { name: "Sending…", exact: true }).waitFor();
    assert(await dialog.getByLabel("What went wrong?").isDisabled());
    let response = await delivery;
    assert.equal(response.status(), failure ? 502 : 200, "Report delivery status");
    if (failure) {
      assert.equal(deliveryRecords().filter((event) => !previousIds.has(event.event_id)).length, 0, "Failed delivery must not create a retained journey event");
      await dialog.getByRole("alert").waitFor();
      assert.equal(await dialog.getByLabel("What went wrong?").inputValue(), description, "Failed delivery must preserve text");
      await tab.screenshot({ path: resolve(evidence, `${name}-delivery-error.png`), animations: "disabled" });
      assert.equal((await fetch(`${webhook}/recover`, { method: "POST" })).status, 204);
      const retry = tab.waitForResponse((response) => response.url().endsWith("/problem-reports") && response.request().method() === "POST");
      await dialog.getByRole("button", { name: "Send", exact: true }).click();
      response = await retry;
      assert.equal(response.status(), 200, "The unchanged draft must deliver after transport recovery");
    }
    const journeyId = response.headers()["x-chalk-journey-id"];
    assert.match(journeyId, /^[0-9a-f-]{36}$/, "Report response keeps its journey ID");
    const ledger = deliveryRecords().filter((event) => !previousIds.has(event.event_id));
    assert.equal(ledger.length, 1, "Only accepted deliveries create a retained journey event");
    assert.equal(ledger[0].state, "succeeded");
    assert.equal(ledger[0].journey_id, ledger[0].event_id, "Delivery owns its report-scoped journey");
    assert.equal(ledger[0].event_id, ledger[0].attributes.report_id);
    assert.notEqual(ledger[0].journey_id, journeyId, "A supplied request journey cannot own delivery evidence");
    assert.deepEqual(Object.keys(ledger[0].attributes).sort(), ["episode_id", "report_id", "space_id", "tenant_id"]);
    await writeFile(resolve(evidence, `${name}-journey.json`), JSON.stringify(ledger, null, 2));
    await tab.getByRole("heading", { name: "Sent", exact: true }).waitFor();
    await tab.screenshot({ path: resolve(evidence, `${name}-success.png`), animations: "disabled" });
    const reports = await received();
    await writeFile(resolve(evidence, "webhook-payloads.json"), JSON.stringify(reports, null, 2));
    const report = reports.at(-1);
    assert(report.content.includes(`${label}: ${name}`));
    for (const field of [`Call: ${call.call.name}`, "Episode ID:", "Reporter:"]) assert(report.content.includes(field), field);
    assert.deepEqual(Object.keys(report).sort(), ["allowed_mentions", "content"]);
    assert(!report.content.includes("Tenant:") && !report.content.includes("UTC:") && !report.content.includes("Episode:"));
    assert.deepEqual(report.allowed_mentions, { parse: [] });
    assert(report.content.length <= 2000);
    assert(!report.content.includes("@example.com"));
    if (diagnostics) for (const field of ["Connection:", "Last error:", "Browser:", "App version:"]) assert(report.content.includes(field), field);
    else assert(!report.content.includes("Diagnostics:"));
    await tab.getByRole("button", { name: "Done", exact: true }).click();
  }
  await page.getByRole("button", { name: "Call details", exact: true }).first().click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidence, "owner-dropdown.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Report a problem", exact: true }).click({ timeout: 10000 });
  await submit(page, { name: "owner", failure: process.env.CHALK_REPORT_LIVE_PROOF !== "1" });
  assert((await received()).at(-1).content.includes("(owner)"));
  const ownerFocusRestored = await page
    .waitForFunction(() => document.activeElement?.matches('button[data-part="call-name"]') && document.activeElement.isConnected, undefined, { timeout: 3000 })
    .then(
      () => true,
      () => false,
    );
  await page.screenshot({ path: resolve(evidence, "owner-report-focus.png"), animations: "disabled" });
  await writeFile(resolve(evidence, "owner-focus-regression.json"), JSON.stringify({ passed: ownerFocusRestored }, null, 2));
  assert(ownerFocusRestored, "Closing the SDK-owned report must focus its persistent Call Details trigger");
  if (process.env.CHALK_REPORT_LIVE_PROOF === "1") {
    assert.equal((await received()).length, 1, "Exactly one live test message");
    await writeFile(resolve(evidence, "live-proof.json"), JSON.stringify({ result: "passed", messages: 1, label }));
    return;
  }
  const session = await page.context().request.get(`${origin}/auth/session`);
  assert.equal(session.status(), 200);
  const { csrfToken } = await session.json();
  const opened = await page.context().request.post(`${origin}/dashboard-api/call`, { headers: { Origin: origin, "X-CSRF-Token": csrfToken }, data: { action: "set-admission", spaceId: call.call.id, admission: "anyone" } });
  assert.equal(opened.status(), 200, await opened.text());
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
    await submit(guest, { name: "guest", diagnostics: false });
    assert((await received()).at(-1).content.includes("Report guest (guest)"));
    await checkGuestRegression("focus returns to mounted Call Details trigger", async () => {
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
      assert.equal((await received()).length, 2, "Exactly one owner and one guest report");
      await writeFile(resolve(evidence, "browser-proof.json"), JSON.stringify({ result: "passed", reports: 2, paths: ["OwnerCall dropdown", "SpacePage dropdown"], mentions: "disabled", ordinaryWebhookProse: "accepted" }));
      return;
    }
    await guest.getByRole("button", { name: "Leave call", exact: true }).click();
    await guest.getByRole("button", { name: "Report a problem", exact: true }).waitFor();
    await guest.screenshot({ path: resolve(evidence, "left-link.png"), animations: "disabled" });
    await guest.getByRole("button", { name: "Report a problem", exact: true }).click();
    await submit(guest, { name: "left" });
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
    await submit(failurePage, { name: "failed" });
    await checkGuestRegression("failed report retains captured terminal diagnostics", async () => {
      const content = (await received()).at(-1).content.replaceAll("\\", "");
      assert(content.includes("Connection: failed"), "Failed-call reports must retain the failed phase after client teardown");
      assert(content.includes("Last error: connection.sync_hello_timeout"), "Failed-call reports must retain the captured Sync failure");
    });

    await checkGuestRegression("expired live guest hides the action and keeps an open draft", async () => {
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
  const policy = await page.context().newPage();
  try {
    await policy.goto(`${origin}/privacy`);
    const disclosure = policy.getByRole("listitem").filter({ hasText: "Discord" });
    await disclosure.waitFor();
    const text = await disclosure.innerText();
    for (const field of ["what you type", "display name and role", "Space name and Episode ID", "If you choose to include diagnostics", "We do not add your account email address"]) assert(text.includes(field), field);
    assert((await policy.locator("body").innerText()).includes("Discord relies on the EU-US Data Privacy Framework adequacy decision"));
    await disclosure.scrollIntoViewIfNeeded();
    await policy.screenshot({ path: resolve(evidence, "privacy-disclosure.png"), animations: "disabled" });
  } finally {
    await policy.close();
  }
  // End a separate real Episode while both participants have live drafts open.
  const draftOwnerContext = await browser.newContext({ storageState: await page.context().storageState(), viewport: { width: 1440, height: 960 } });
  const draftGuestContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  try {
    const owner = await draftOwnerContext.newPage();
    const participant = await draftGuestContext.newPage();
    await owner.goto(`${origin}/dashboard`);
    await owner.getByRole("button", { name: "Start a call", exact: true }).click();
    await owner.getByRole("button", { name: "Join call", exact: true }).click();
    await owner.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    const spaceId = new URL(owner.url()).pathname.split("/").at(-2);
    const read = await draftOwnerContext.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`);
    assert.equal(read.status(), 200);
    const separateCall = await read.json();
    const open = await draftOwnerContext.request.post(`${origin}/dashboard-api/call`, { headers: { Origin: origin, "X-CSRF-Token": csrfToken }, data: { action: "set-admission", spaceId, admission: "anyone" } });
    assert.equal(open.status(), 200);
    const invite = new URL(separateCall.inviteUrl);
    await participant.goto(`${origin}${invite.pathname}${invite.search}${invite.hash}`);
    await participant.getByLabel("Your name").fill("Draft participant");
    await participant.getByRole("button", { name: "Join call", exact: true }).click();
    await participant.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    const drafts = [];
    for (const [role, tab] of [
      ["owner", owner],
      ["guest", participant],
    ]) {
      await tab.getByRole("button", { name: "Call details", exact: true }).first().click();
      await tab.getByRole("button", { name: "Report a problem", exact: true }).click();
      const input = tab.getByLabel("What went wrong?");
      await input.fill(`Keep this ${role} live report draft`);
      drafts.push({ role, tab, input: await input.elementHandle() });
      await tab.screenshot({ path: resolve(evidence, `draft-${role}-before-end.png`), animations: "disabled" });
    }
    const end = await draftOwnerContext.request.post(`${origin}/dashboard-api/call`, { headers: { Origin: origin, "X-CSRF-Token": csrfToken }, data: { action: "end-for-everyone", spaceId, episodeId: separateCall.live.id, idempotencyKey: randomUUID() } });
    assert.equal(end.status(), 200, await end.text());
    for (const { role, tab, input } of drafts) {
      await tab.getByText("The call ended", { exact: true }).waitFor();
      assert(await input.evaluate((element) => element.isConnected), `${role} report textarea must remain mounted`);
      assert.equal(await tab.getByLabel("What went wrong?").inputValue(), `Keep this ${role} live report draft`);
      assert(!(await tab.getByLabel("What went wrong?").isDisabled()));
      await tab.screenshot({ path: resolve(evidence, `draft-${role}-after-end.png`), animations: "disabled" });
    }
    await writeFile(resolve(evidence, "draft-transition.json"), JSON.stringify({ result: "passed", paths: ["owner SDK terminal", "guest app-owned terminal"], textareaRetained: true, textRetained: true }));
  } finally {
    await draftGuestContext.close();
    await draftOwnerContext.close();
  }
  // Clock installation affects its whole context; keep the reload journey on real time.
  const failedOwnerContext = await browser.newContext({
    storageState: await page.context().storageState(),
    viewport: { width: 1440, height: 960 },
    ...(process.env.CHALK_REPORT_VIDEO === "1" ? { recordVideo: { dir: resolve(evidence, "videos"), size: { width: 1440, height: 960 } } } : {}),
  });
  const failedOwner = await failedOwnerContext.newPage();
  try {
    await failedOwner.clock.install();
    let interceptedOwnerSync = 0;
    await failedOwner.routeWebSocket(/\/v1\/sync(?:\?|$)/, (socket) => {
      interceptedOwnerSync++;
      socket.onMessage(() => {});
    });
    await failedOwner.goto(`${origin}/dashboard`);
    await failedOwner.getByRole("button", { name: "Start a call", exact: true }).click();
    await failedOwner.getByRole("button", { name: "Join call", exact: true }).click();
    await failedOwner.getByText(/Could(?: not|n’t) connect to/).waitFor({ timeout: 45000 });
    assert(interceptedOwnerSync > 0, "Owner failure must follow a real admission and intercepted Sync connection");
    await failedOwner.getByRole("button", { name: "Report a problem", exact: true }).waitFor();
    await failedOwner.screenshot({ path: resolve(evidence, "owner-before-expiry.png"), animations: "disabled" });
    await failedOwner.clock.fastForward(301_000);
    await failedOwner.screenshot({ path: resolve(evidence, "owner-after-expiry.png"), animations: "disabled" });
    assert.equal(await failedOwner.getByRole("button", { name: "Report a problem", exact: true }).count(), 0, "Expired owner reporting must disappear after the five-minute credential lifetime");
  } finally {
    await failedOwnerContext.close();
  }
  await writeFile(resolve(evidence, "browser-proof.json"), JSON.stringify({ result: "passed", reports: (await received()).length, paths: ["OwnerCall dropdown", "SpacePage dropdown", "left screen", "failed screen"] }));
}
