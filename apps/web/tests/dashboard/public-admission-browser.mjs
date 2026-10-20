import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

// Real dashboard Start a call, isolated guest, real API/Sync and real SDK UI.
// Only the remote media vendor is replaced by real-engine.sh's local fixture.
export async function provePublicAdmission({ browser, page, origin, apiOrigin, tenantId, spaceId, inviteUrl, repository }) {
  const out = resolve(repository, "artifacts/fix-admit");
  await mkdir(out, { recursive: true });
  await page.getByRole("button", { name: "Close call link", exact: true }).click();
  const invite = new URL(inviteUrl);
  const guestUrl = `${origin}${invite.pathname}${invite.search}${invite.hash}`;
  async function knock(name) {
    const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
    const guest = await context.newPage();
    try {
      await guest.goto(guestUrl);
      await guest.getByLabel("Your name").fill(name);
      await guest.getByRole("button", { name: "Join", exact: true }).click();
      await guest.getByText(/Asking to join/).waitFor();
      await page.getByRole("button", { name: `Admit ${name}`, exact: true }).waitFor({ timeout: 15000 });
      const badge = page.getByLabel("1 waiting to join", { exact: true });
      await badge.waitFor();
      assert.equal(await page.getByRole("tab", { name: /^People/ }).getAttribute("aria-selected"), "true", "A public knock opens People automatically");
      return { context, guest };
    } catch (error) {
      await page.screenshot({ path: resolve(out, "failure-host.png") });
      await guest.screenshot({ path: resolve(out, "failure-guest.png") });
      await context.close();
      throw error;
    }
  }
  const approved = await knock("Approve guest");
  try {
    await page.screenshot({ path: resolve(out, "after-host-pending.png") });
    await approved.guest.screenshot({ path: resolve(out, "after-guest-pending.png") });
    await page.getByRole("button", { name: "Admit Approve guest", exact: true }).click();
    await approved.guest.getByTestId("stage").waitFor({ timeout: 15000 });
    await page.getByLabel("1 waiting to join", { exact: true }).waitFor({ state: "hidden" });
    await approved.guest.screenshot({ path: resolve(out, "after-guest-admitted.png") });
    await approved.guest.getByRole("button", { name: "Leave call", exact: true }).click();
    await approved.guest.getByRole("menuitem", { name: "Leave call", exact: true }).click();
    await approved.guest.getByRole("heading", { name: /You left/ }).waitFor();
  } finally {
    await approved.context.close();
  }

  const denied = await knock("Deny guest");
  try {
    await page.getByRole("button", { name: "Deny Deny guest", exact: true }).click();
    await denied.guest.getByText("The host declined your request to join.", { exact: true }).waitFor({ timeout: 15000 });
    await denied.guest.screenshot({ path: resolve(out, "after-guest-denied.png") });
  } finally {
    await denied.context.close();
  }

  const expired = await knock("Expired guest");
  try {
    // Advance only this disposable request's deadline; use the real sweep and
    // Sync expiry operation, without waiting five minutes in every proof run.
    await promisify(execFile)("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-c", `update sync_admission_requests set expires_at=now() where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Expired guest' and status='pending'`]);
    await expired.guest.getByText("Your request to join expired or is no longer available.", { exact: true }).waitFor({ timeout: 20000 });
    await page.getByRole("button", { name: "Admit Expired guest", exact: true }).waitFor({ state: "hidden", timeout: 20000 });
    await page.getByLabel("1 waiting to join", { exact: true }).waitFor({ state: "hidden" });
    await expired.guest.screenshot({ path: resolve(out, "after-guest-expired.png") });
    assert.equal(await expired.guest.getByText(/Chalk could not connect/).count(), 0);
  } finally {
    await expired.context.close();
  }

  // Dashboard detail controls use the exact same canonical request and Sync
  // decision operation as the live SDK's Admit/Deny buttons.
  for (const action of ["approve-knock", "deny-knock"]) {
    const name = action === "approve-knock" ? "Dashboard approve guest" : "Dashboard deny guest";
    const pending = await knock(name);
    try {
      const response = await page.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`);
      assert.equal(response.status(), 200, await response.text());
      const call = await response.json();
      const request = call.knocks.find((request) => request.name === name);
      assert(request, "Dashboard detail reads the live public knock");
      const decision = await page.request.post(`${origin}/dashboard-api/call`, { data: { action, spaceId, requestHandle: request.handle, idempotencyKey: crypto.randomUUID() } });
      assert.equal(decision.status(), 200, await decision.text());
      if (action === "approve-knock") {
        await pending.guest.getByTestId("stage").waitFor({ timeout: 15000 });
        await pending.guest.getByRole("button", { name: "Leave call", exact: true }).click();
        await pending.guest.getByRole("menuitem", { name: "Leave call", exact: true }).click();
        await pending.guest.getByRole("heading", { name: /You left/ }).waitFor();
      } else {
        await pending.guest.getByText("The host declined your request to join.", { exact: true }).waitFor({ timeout: 15000 });
      }
    } finally {
      await pending.context.close();
    }
  }
  console.log("PASS: signed-in dashboard Start a call → isolated public guest → host prompt and People badge → live approve/deny → terminal expiry → dashboard approve/deny share Sync admission");
}
