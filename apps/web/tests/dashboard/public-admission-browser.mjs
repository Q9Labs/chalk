import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { knock, terminalProjection, waitForSql } from "./admission-support.mjs";
import { proveDashboardDecisionRetry, proveDashboardWithoutHost, proveInvalidationTick } from "./admission-dashboard-proofs.mjs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Real dashboard Start a call, isolated guest, real API/Sync and real SDK UI.
// Only the remote media vendor is replaced by real-engine.sh's local fixture.
export async function provePublicAdmission({ browser, page, origin, tenantId, spaceId, inviteUrl, repository }) {
  const out = resolve(repository, "artifacts/fix-admit");
  await mkdir(out, { recursive: true });
  await page.getByRole("dialog", { name: "Call details", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  const invite = new URL(inviteUrl);
  const guestUrl = `${origin}${invite.pathname}${invite.search}${invite.hash}`;
  const journeys = [];
  const terminalLedger = [];
  const c = { browser, page, origin, tenantId, spaceId, guestUrl, out, journeys, terminalLedger, repository };
  if (process.argv.includes("--admission-dashboard-retry")) {
    await proveDashboardDecisionRetry(c);
    return;
  }
  if (process.argv.includes("--admission-invalidation")) {
    await proveInvalidationTick(c);
    return;
  }
  if (process.argv.includes("--admission-dashboard")) {
    await proveDashboardWithoutHost(c);
    return;
  }
  const approved = await knock(c, "Approve guest");
  try {
    await page.screenshot({ path: resolve(out, "after-host-pending.png") });
    await approved.guest.screenshot({ path: resolve(out, "after-guest-pending.png") });
    await page.getByRole("button", { name: "Let Approve guest in", exact: true }).click();
    await approved.guest.getByTestId("stage").waitFor({ timeout: 15000 });
    await approved.guest.getByRole("group", { name: "Stage with 2 participants", exact: true }).waitFor({ timeout: 15000 });
    await page.getByLabel("1 waiting to join", { exact: true }).waitFor({ state: "hidden" });
    await terminalProjection(c, "Approve guest", "approved");
    await approved.guest.screenshot({ path: resolve(out, "after-guest-admitted.png") });
    await approved.guest.getByRole("button", { name: "Leave call", exact: true }).click();
    await approved.guest.getByRole("heading", { name: /You left/ }).waitFor();
  } finally {
    await approved.context.close();
  }

  const denied = await knock(c, "Deny guest");
  try {
    await page.getByRole("button", { name: "Decline Deny guest", exact: true }).click();
    await denied.guest.getByText("The host didn’t let you in", { exact: true }).waitFor({ timeout: 15000 });
    await terminalProjection(c, "Deny guest", "denied");
    await denied.guest.screenshot({ path: resolve(out, "after-guest-denied.png") });
  } finally {
    await denied.context.close();
  }

  const expired = await knock(c, "Expired guest");
  try {
    // Advance only this disposable request's deadline; use the real sweep and
    // Sync expiry operation, without waiting five minutes in every proof run.
    await promisify(execFile)("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c", `update sync_admission_requests set expires_at=now() where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Expired guest' and status='pending'`]);
    await expired.guest.getByText("Your request to join expired or is no longer available.", { exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Let Expired guest in", exact: true }).waitFor({ state: "hidden", timeout: 20000 });
    await page.getByLabel("1 waiting to join", { exact: true }).waitFor({ state: "hidden" });
    await terminalProjection(c, "Expired guest", "expired");
    await expired.guest.screenshot({ path: resolve(out, "after-guest-expired.png") });
    assert.equal(await expired.guest.getByText(/Couldn’t reach Chalk|Chalk is having trouble/).count(), 0);
  } finally {
    await expired.context.close();
  }

  // Dashboard detail controls use the exact same canonical request and Sync
  // decision operation as the live SDK's Let in/Decline buttons.
  const session = await page.request.get(`${origin}/auth/session`);
  assert.equal(session.status(), 200);
  const { csrfToken } = await session.json();
  assert.equal(typeof csrfToken, "string");
  for (const action of ["approve-knock", "deny-knock"]) {
    const name = action === "approve-knock" ? "Dashboard approve guest" : "Dashboard deny guest";
    const pending = await knock(c, name);
    try {
      const response = await page.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`);
      assert.equal(response.status(), 200, await response.text());
      const call = await response.json();
      const request = call.knocks.find((request) => request.name === name);
      assert(request, "Dashboard detail reads the live public knock");
      const decision = await page.request.post(`${origin}/dashboard-api/call`, {
        headers: { Origin: origin, "X-CSRF-Token": csrfToken },
        data: {
          action,
          spaceId,
          requestHandle: request.handle,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      assert.equal(decision.status(), 200, await decision.text());
      if (action === "approve-knock") {
        await pending.guest.getByTestId("stage").waitFor({ timeout: 15000 });
        await pending.guest.getByRole("button", { name: "Leave call", exact: true }).click();
        await pending.guest.getByRole("heading", { name: /You left/ }).waitFor();
      } else {
        await pending.guest.getByText("The host didn’t let you in", { exact: true }).waitFor({ timeout: 15000 });
      }
    } finally {
      await pending.context.close();
    }
  }
  const abandoned = await knock(c, "Uncollected guest");
  await abandoned.context.close();
  await page.getByRole("button", { name: "Let Uncollected guest in", exact: true }).click();
  await waitForSql(c, `select status from sync_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Uncollected guest'`, "admitted");
  await promisify(execFile)("psql", [
    process.env.CHALK_DATABASE_URL,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `update sync_admission_requests set requested_at=now()-interval '6 minutes', expires_at=now()-interval '2 minutes', completed_at=now()-interval '2 minutes' where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Uncollected guest'`,
  ]);
  await waitForSql(
    c,
    `select participant.status from participants participant join sync_admission_requests request on request.tenant_id=participant.tenant_id and request.episode_id=participant.episode_id and request.participant_id=participant.id where request.tenant_id='${tenantId}' and request.space_id='${spaceId}' and request.display_name='Uncollected guest'`,
    "left",
  );
  await page.screenshot({ path: resolve(out, "after-uncollected-seat-removed.png") });

  await proveDashboardWithoutHost(c);

  const apiLog = await readFile(resolve(repository, "artifacts/dashboard-api.log"), "utf8");
  for (const reason of ["approved", "admission_denied", "admission_request_expired", "admission_not_collected"]) {
    assert(
      apiLog.split("\n").some((line) => line.includes("public_invite.admission") && line.includes(reason)),
      `Missing structured admission outcome: ${reason}`,
    );
  }
  await writeFile(resolve(out, "admission-journeys.json"), JSON.stringify(journeys, null, 2));
  await writeFile(resolve(out, "admission-terminal-ledger.json"), JSON.stringify(terminalLedger, null, 2));
  console.log("PASS: signed-in dashboard Start a call → isolated public guest → host prompt and People badge → live approve/deny → terminal expiry → dashboard approve/deny share Sync admission");
}
