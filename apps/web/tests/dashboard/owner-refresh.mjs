import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";
import { assertNoSeatCookies, proveCookieBudget, proveSignOutCleanup } from "./owner-cookie-budget.mjs";
import { proveEvictionReload } from "./owner-eviction.mjs";

const fixture = await createDashboardProofFixture({ devicesMissing: true, recordingName: "dashboard-owner-refresh.webm" });
const { context, origin, cleanup, recordPage } = fixture;
const pendingResponses = [];
function callResponse(page, action) {
  const response = page.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === action, { timeout: 330000 });
  pendingResponses.push(response);
  return response;
}
async function access(response) {
  assert.equal(response.status(), 200, `Owner call returned HTTP ${response.status()}`);
  return (await response.json()).access;
}
try {
  const first = await context.newPage();
  recordPage(first);
  await first.goto(`${origin}/dashboard`);
  await first.getByRole("button", { name: "Start a call", exact: true }).click();
  const firstJoined = callResponse(first, "join");
  await first.getByRole("button", { name: "Join call", exact: true }).click();
  const original = await access(await firstJoined);
  await first.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
  const firstRefreshed = callResponse(first, "refresh-access");
  const second = await context.newPage();
  const secondJoined = callResponse(second, "join");
  await second.goto(first.url());
  const sibling = await access(await secondJoined);
  assert.notEqual(original.subject.participant_id, sibling.subject.participant_id);
  await second.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
  const secondRefreshed = callResponse(second, "refresh-access");
  await proveEvictionReload(context, origin);
  await proveCookieBudget(context, origin);
  const leaving = await context.newPage();
  await leaving.goto(`${origin}/dashboard`);
  await leaving.getByRole("button", { name: "Start a call", exact: true }).click();
  await leaving.getByRole("button", { name: "Join call", exact: true }).click();
  await leaving.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
  const leaveCleanup = leaving.waitForResponse(`${origin}/auth/clear-owner-seats`);
  pendingResponses.push(leaveCleanup);
  const leave = leaving.getByRole("button", { name: "Leave call", exact: true });
  const opensMenu = (await leave.getAttribute("aria-haspopup")) === "menu";
  await leave.click();
  if (opensMenu) await leaving.getByRole("menuitem", { name: "Leave call", exact: true }).click();
  assert.equal((await leaveCleanup).status(), 200);
  await assertNoSeatCookies(context);
  await leaving.close();
  console.log("PASS: real UI Leave clears the bounded cache without disrupting sibling tabs");
  const refreshed = await Promise.all([firstRefreshed, secondRefreshed].map(async (response) => access(await response)));
  for (const [index, previous] of [original, sibling].entries()) {
    assert.equal(refreshed[index].subject.participant_id, previous.subject.participant_id, "Refresh must retain its own tab's seat");
    assert(Date.parse(refreshed[index].media.expires_at) > Date.parse(previous.media.expires_at), "Scheduled refresh must renew credentials");
  }
  // Cross the original five-minute expiry using real clocks, not an accelerated timer.
  await delay(Math.max(0, Math.max(...[original, sibling].map((grant) => Date.parse(grant.media.expires_at))) + 5000 - Date.now()));
  for (const page of [first, second]) await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 10000 });
  await first.bringToFront();
  await first.mouse.move(200, 200);
  const endCleanup = first.waitForResponse(`${origin}/auth/clear-owner-seats`);
  pendingResponses.push(endCleanup);
  await first.getByRole("button", { name: "Leave call", exact: true }).click();
  await first.getByRole("menuitem", { name: "End call for everyone", exact: true }).click();
  for (const page of [first, second]) await page.getByRole("heading", { name: "The call ended", exact: true }).waitFor({ timeout: 30000 });
  assert.equal((await endCleanup).status(), 200);
  await assertNoSeatCookies(context);
  console.log("PASS: shared-browser owner tabs independently refresh, survive original five-minute credential expiry, and end for everyone through real Sync");
  await proveSignOutCleanup(context, origin);
} finally {
  // A failed independent assertion cancels response waiters during browser teardown.
  // Attach handlers before closing so those cancellations cannot mask its error.
  const settled = Promise.allSettled(pendingResponses);
  await cleanup();
  await settled;
}
