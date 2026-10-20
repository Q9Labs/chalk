import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

// Real dashboard Start a call, isolated guest, real API/Sync and real SDK UI.
// Only the remote media vendor is replaced by real-engine.sh's local fixture.
export async function provePublicAdmission({
  browser,
  page,
  origin,
  tenantId,
  spaceId,
  inviteUrl,
  repository,
}) {
  const before = process.argv.includes("--admission-before");
  const out = resolve(repository, "artifacts/fix-admit");
  await mkdir(out, { recursive: true });
  await page.getByRole("button", { name: "Close call link", exact: true }).click();
  const invite = new URL(inviteUrl);
  const guestUrl = `${origin}${invite.pathname}${invite.search}${invite.hash}`;
  async function sql(query) {
    const { stdout } = await promisify(execFile)("psql", [
      process.env.CHALK_DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-c",
      query,
    ]);
    return stdout.trim();
  }
  async function terminalProjection(name, state) {
    assert.equal(
      await sql(
        `select public.state from space_public_admission_requests public join sync_admission_requests live on live.admission_request_id=public.request_handle where public.tenant_id='${tenantId}' and public.space_id='${spaceId}' and public.display_name='${name}'`,
      ),
      state,
      "Sync commits the public terminal projection, removing it from the pending index",
    );
  }
  async function knock(name) {
    const journeyId = crypto.randomUUID();
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const context = await browser.newContext({
      extraHTTPHeaders: {
        "x-chalk-journey-id": journeyId,
        traceparent: `00-${traceId}-0123456789abcdef-01`,
      },
      viewport: { width: 1200, height: 850 },
      recordVideo: {
        dir: resolve(
          out,
          `${before ? "before" : "after"}-${name.toLowerCase().replaceAll(" ", "-")}-video`,
        ),
        size: { width: 1200, height: 850 },
      },
    });
    const guest = await context.newPage();
    try {
      await guest.goto(guestUrl);
      await guest.getByLabel("Your name").fill(name);
      await guest.getByRole("button", { name: "Join", exact: true }).click();
      await guest.getByText(/Asking to join/).waitFor();
      if (before) return { context, guest };
      await page
        .getByRole("button", { name: `Admit ${name}`, exact: true })
        .waitFor({ timeout: 15000 });
      const badge = page.getByLabel("1 waiting to join", { exact: true });
      await badge.waitFor();
      assert.equal(
        await page.getByRole("tab", { name: /^People/ }).getAttribute("aria-selected"),
        "true",
        "A public knock opens People automatically",
      );
      assert.equal(
        await sql(
          `select count(*) from sync_admission_requests admission join sync_lifecycle_intents intent on intent.tenant_id=admission.tenant_id and intent.episode_id=admission.episode_id and intent.intent_name='admission_requested' and intent.payload->>'admission_request_id'=admission.admission_request_id::text join observability_journey_events root on root.event_id=intent.parent_journey_event_id where admission.tenant_id='${tenantId}' and admission.space_id='${spaceId}' and admission.display_name='${name}' and intent.journey_id='${journeyId}' and intent.producing_trace_id='${traceId}' and intent.status='applied' and root.journey_id=intent.journey_id`,
        ),
        "1",
        "The HTTP journey and W3C trace reach the durable admission intent and ledger root",
      );
      return { context, guest };
    } catch (error) {
      await page.screenshot({ path: resolve(out, "failure-host.png") });
      await guest.screenshot({ path: resolve(out, "failure-guest.png") });
      await context.close();
      throw error;
    }
  }
  if (before) {
    const pending = await knock("Approve guest");
    try {
      await page.getByRole("button", { name: /^People,/ }).click();
      await page.getByRole("region", { name: "People", exact: true }).waitFor();
      await assert.rejects(
        page
          .getByRole("button", { name: "Admit Approve guest", exact: true })
          .waitFor({ timeout: 5000 }),
        { name: "TimeoutError" },
      );
      assert.equal(await page.getByLabel("1 waiting to join", { exact: true }).count(), 0);
      await page.screenshot({ path: resolve(out, "before-host-pending.png") });
      await pending.guest.screenshot({ path: resolve(out, "before-guest-pending.png") });
      console.log(
        "REPRODUCED: signed-in dashboard call → isolated guest waiting → no host admission prompt or People badge",
      );
    } finally {
      await pending.context.close();
    }
    return;
  }
  const approved = await knock("Approve guest");
  try {
    await page.screenshot({ path: resolve(out, "after-host-pending.png") });
    await approved.guest.screenshot({ path: resolve(out, "after-guest-pending.png") });
    await page.getByRole("button", { name: "Admit Approve guest", exact: true }).click();
    await approved.guest.getByTestId("stage").waitFor({ timeout: 15000 });
    await approved.guest
      .getByRole("group", { name: "Stage with 2 participants", exact: true })
      .waitFor({ timeout: 15000 });
    await page.getByLabel("1 waiting to join", { exact: true }).waitFor({ state: "hidden" });
    await terminalProjection("Approve guest", "approved");
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
    await denied.guest
      .getByText("The host declined your request to join.", { exact: true })
      .waitFor({ timeout: 15000 });
    await terminalProjection("Deny guest", "denied");
    await denied.guest.screenshot({ path: resolve(out, "after-guest-denied.png") });
  } finally {
    await denied.context.close();
  }

  const expired = await knock("Expired guest");
  try {
    // Advance only this disposable request's deadline; use the real sweep and
    // Sync expiry operation, without waiting five minutes in every proof run.
    await promisify(execFile)("psql", [
      process.env.CHALK_DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `update sync_admission_requests set expires_at=now() where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Expired guest' and status='pending'`,
    ]);
    await expired.guest
      .getByText("Your request to join expired or is no longer available.", { exact: true })
      .waitFor({ timeout: 20000 });
    await page
      .getByRole("button", { name: "Admit Expired guest", exact: true })
      .waitFor({ state: "hidden", timeout: 20000 });
    await page.getByLabel("1 waiting to join", { exact: true }).waitFor({ state: "hidden" });
    await terminalProjection("Expired guest", "expired");
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
      const decision = await page.request.post(`${origin}/dashboard-api/call`, {
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
        await pending.guest.getByRole("menuitem", { name: "Leave call", exact: true }).click();
        await pending.guest.getByRole("heading", { name: /You left/ }).waitFor();
      } else {
        await pending.guest
          .getByText("The host declined your request to join.", { exact: true })
          .waitFor({ timeout: 15000 });
      }
    } finally {
      await pending.context.close();
    }
  }
  const apiLog = await readFile(resolve(repository, "artifacts/dashboard-api.log"), "utf8");
  for (const reason of ["approved", "admission_denied", "admission_request_expired"]) {
    assert(
      apiLog
        .split("\n")
        .some((line) => line.includes("public_invite.admission") && line.includes(reason)),
      `Missing structured admission outcome: ${reason}`,
    );
  }
  console.log(
    "PASS: signed-in dashboard Start a call → isolated public guest → host prompt and People badge → live approve/deny → terminal expiry → dashboard approve/deny share Sync admission",
  );
}
