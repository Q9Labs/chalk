import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

const fixture = await createDashboardProofFixture({ devicesMissing: true, recordingName: "dashboard-owner-refresh.webm" });
const { context, origin, cleanup, recordPage } = fixture;
function callResponse(page, action) {
  return page.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === action, { timeout: 330000 });
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
  await first.getByRole("button", { name: "Leave call", exact: true }).click();
  await first.getByRole("menuitem", { name: "End call for everyone", exact: true }).click();
  for (const page of [first, second]) await page.getByRole("heading", { name: "The call ended", exact: true }).waitFor({ timeout: 30000 });
  console.log("PASS: shared-browser owner tabs independently refresh, survive original five-minute credential expiry, and end for everyone through real Sync");
} finally {
  await cleanup();
}
