import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// Real dashboard Start a call, isolated guest, real API/Sync and real SDK UI.
// Only the remote media vendor is replaced by real-engine.sh's local fixture.
export async function provePublicAdmission({ browser, page, origin, tenantId, spaceId, inviteUrl, repository }) {
  const before = process.argv.includes("--admission-before");
  const out = resolve(repository, "artifacts/fix-admit");
  await mkdir(out, { recursive: true });
  await page.getByRole("button", { name: "Close call link", exact: true }).click();
  const invite = new URL(inviteUrl);
  const guestUrl = `${origin}${invite.pathname}${invite.search}${invite.hash}`;
  const journeys = [];
  const terminalLedger = [];
  async function sql(query) {
    const { stdout } = await promisify(execFile)("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", query]);
    return stdout.trim();
  }
  async function terminalProjection(name, state) {
    const evidence = JSON.parse(
      await sql(
        `select json_build_object('state', public.state, 'journeyId', operation.journey_id, 'traceId', operation.producing_trace_id, 'ledgerEventId', root.event_id) from space_public_admission_requests public join sync_admission_requests live on live.admission_request_id=public.request_handle join sync_external_operations operation on operation.tenant_id=live.tenant_id and operation.external_operation_id=live.decision_external_operation_id join observability_journey_events root on root.event_id=operation.parent_journey_event_id and root.journey_id=operation.journey_id where public.tenant_id='${tenantId}' and public.space_id='${spaceId}' and public.display_name='${name}'`,
      ),
    );
    assert.equal(evidence.state, state);
    assert(evidence.journeyId && evidence.ledgerEventId, "Terminal decision retains its durable journey ledger");
    if (process.env.CHALK_API_OTLP_ENDPOINT) assert(evidence.traceId, "Instrumented terminal decision retains its producing trace");
    terminalLedger.push({ name, ...evidence });
    assert.equal(
      await sql(`select public.state from space_public_admission_requests public join sync_admission_requests live on live.admission_request_id=public.request_handle where public.tenant_id='${tenantId}' and public.space_id='${spaceId}' and public.display_name='${name}'`),
      state,
      "Sync commits the public terminal projection, removing it from the pending index",
    );
  }
  async function waitForSql(query, expected) {
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await sql(query)) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    assert.equal(await sql(query), expected);
  }
  async function knock(name, dashboard = false) {
    const journeyId = crypto.randomUUID();
    const traceId = crypto.randomUUID().replaceAll("-", "");
    const context = await browser.newContext({
      extraHTTPHeaders: {
        "x-chalk-journey-id": journeyId,
        traceparent: `00-${traceId}-0123456789abcdef-01`,
      },
      viewport: { width: 1200, height: 850 },
      recordVideo: {
        dir: resolve(out, `${before ? "before" : "after"}-${name.toLowerCase().replaceAll(" ", "-")}-video`),
        size: { width: 1200, height: 850 },
      },
    });
    const guest = await context.newPage();
    const failures = [];
    guest.on("requestfailed", (request) => {
      if (failures.length < 100) failures.push({ url: request.url(), error: request.failure()?.errorText });
    });
    guest.on("console", (message) => {
      if (message.type() === "error" && failures.length < 100) failures.push({ error: message.text() });
    });
    guest.on("pageerror", (error) => {
      if (failures.length < 100) failures.push({ error: error.message });
    });
    try {
      await guest.goto(guestUrl);
      await guest.getByLabel("Your name").fill(name);
      await guest.getByRole("button", { name: "Join", exact: true }).click();
      await guest.getByText(/Asking to join/).waitFor();
      if (before || dashboard) return { context, guest };
      await page.getByRole("button", { name: `Admit ${name}`, exact: true }).waitFor({ timeout: 15000 });
      const badge = page.getByLabel("1 waiting to join", { exact: true });
      await badge.waitFor();
      assert.equal(await page.getByRole("tab", { name: /^People/ }).getAttribute("aria-selected"), "true", "A public knock opens People automatically");
      assert.equal(
        await sql(
          `select count(*) from sync_admission_requests admission join sync_lifecycle_intents intent on intent.tenant_id=admission.tenant_id and intent.episode_id=admission.episode_id and intent.intent_name='admission_requested' and intent.payload->>'admission_request_id'=admission.admission_request_id::text join observability_journey_events root on root.event_id=intent.parent_journey_event_id where admission.tenant_id='${tenantId}' and admission.space_id='${spaceId}' and admission.display_name='${name}' and intent.journey_id='${journeyId}' and intent.producing_trace_id='${traceId}' and intent.status='applied' and root.journey_id=intent.journey_id`,
        ),
        "1",
        "The HTTP journey and W3C trace reach the durable admission intent and ledger root",
      );
      journeys.push({ name, journeyId, traceId });
      return { context, guest };
    } catch (error) {
      await writeFile(resolve(out, "failure-guest-network.json"), JSON.stringify(failures, null, 2));
      await page.screenshot({ path: resolve(out, "failure-host.png") });
      await guest.screenshot({ path: resolve(out, "failure-guest.png") });
      await context.close();
      throw error;
    }
  }
  async function proveDashboardWithoutHost() {
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
    await page.getByRole("heading", { name: /You left/ }).waitFor();
    const activeSeats = `select count(*) from participants p join episodes e on e.tenant_id=p.tenant_id and e.id=p.episode_id where e.tenant_id='${tenantId}' and e.space_id='${spaceId}' and p.status='active'`;
    await waitForSql(activeSeats, "0");
    await page.goto(`${origin}/dashboard/call/${spaceId}`);
    await page.getByRole("link", { name: "Join call", exact: true }).waitFor();
    const dashboardDocument = crypto.randomUUID();
    await page.evaluate((marker) => {
      window.admissionProofDocument = marker;
    }, dashboardDocument);
    const pending = await knock("Hostless dashboard guest", true);
    try {
      const guestDocument = crypto.randomUUID();
      await pending.guest.evaluate((marker) => {
        window.admissionProofDocument = marker;
      }, guestDocument);
      const row = page.locator(".orow").filter({ hasText: "Hostless dashboard guest" });
      try {
        await row.getByRole("button", { name: "Let in", exact: true }).waitFor({ timeout: 15000 });
      } catch (error) {
        await page.screenshot({ path: resolve(out, "before-dashboard-missing-knock.png") });
        await pending.guest.screenshot({ path: resolve(out, "before-dashboard-guest-waiting.png") });
        throw error;
      }
      assert.equal(await sql(`select count(*) from episodes where tenant_id='${tenantId}' and space_id='${spaceId}' and status='active'`), "1", "Approval targets an existing live Episode");
      assert.equal(await sql(activeSeats), "0", "Dashboard approval has no connected host or participant");
      assert.equal(await page.evaluate(() => window.admissionProofDocument), dashboardDocument, "Knock appeared without dashboard document reload");
      await page.screenshot({ path: resolve(out, "after-dashboard-live-knock.png") });
      await row.getByRole("button", { name: "Let in", exact: true }).click();
      await pending.guest.getByTestId("stage").waitFor({ timeout: 20000 });
      await pending.guest.getByRole("group", { name: "Stage with 1 participant", exact: true }).waitFor({ timeout: 15000 });
      assert.equal(await pending.guest.evaluate(() => window.admissionProofDocument), guestDocument, "Guest entered automatically without document reload");
      assert.equal(await page.evaluate(() => window.admissionProofDocument), dashboardDocument);
      await row.waitFor({ state: "hidden" });
      await pending.guest.screenshot({ path: resolve(out, "after-dashboard-hostless-guest-admitted.png") });
      await terminalProjection("Hostless dashboard guest", "approved");
      await writeFile(resolve(out, "dashboard-live-acceptance.json"), JSON.stringify({ dashboardKnockWithoutReload: true, connectedParticipantsBeforeApproval: 0, liveEpisodesBeforeApproval: 1, dashboardLetIn: true, guestStageParticipants: 1, guestEnteredWithoutRefresh: true }, null, 2));
      await pending.guest.getByRole("button", { name: "Leave call", exact: true }).click();
      await pending.guest.getByRole("heading", { name: /You left/ }).waitFor();
      console.log("PASS: already-open dashboard receives a live knock without reload → Let in with zero connected hosts → guest enters the one-person stage without refresh");
    } finally {
      await pending.context.close();
    }
  }
  if (process.argv.includes("--admission-dashboard-before")) {
    await proveDashboardWithoutHost();
    return;
  }
  if (before) {
    const pending = await knock("Approve guest");
    try {
      await page.getByRole("button", { name: /^People,/ }).click();
      await page.getByRole("region", { name: "People", exact: true }).waitFor();
      await assert.rejects(page.getByRole("button", { name: "Admit Approve guest", exact: true }).waitFor({ timeout: 5000 }), { name: "TimeoutError" });
      assert.equal(await page.getByLabel("1 waiting to join", { exact: true }).count(), 0);
      await page.screenshot({ path: resolve(out, "before-host-pending.png") });
      await pending.guest.screenshot({ path: resolve(out, "before-guest-pending.png") });
      console.log("REPRODUCED: signed-in dashboard call → isolated guest waiting → no host admission prompt or People badge");
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
    await approved.guest.getByRole("group", { name: "Stage with 2 participants", exact: true }).waitFor({ timeout: 15000 });
    await page.getByLabel("1 waiting to join", { exact: true }).waitFor({ state: "hidden" });
    await terminalProjection("Approve guest", "approved");
    await approved.guest.screenshot({ path: resolve(out, "after-guest-admitted.png") });
    await approved.guest.getByRole("button", { name: "Leave call", exact: true }).click();
    await approved.guest.getByRole("heading", { name: /You left/ }).waitFor();
  } finally {
    await approved.context.close();
  }

  const denied = await knock("Deny guest");
  try {
    await page.getByRole("button", { name: "Deny Deny guest", exact: true }).click();
    await denied.guest.getByText("The host declined your request to join.", { exact: true }).waitFor({ timeout: 15000 });
    await terminalProjection("Deny guest", "denied");
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
    await terminalProjection("Expired guest", "expired");
    await expired.guest.screenshot({ path: resolve(out, "after-guest-expired.png") });
    assert.equal(await expired.guest.getByText(/Chalk could not connect/).count(), 0);
  } finally {
    await expired.context.close();
  }

  // Dashboard detail controls use the exact same canonical request and Sync
  // decision operation as the live SDK's Admit/Deny buttons.
  const session = await page.request.get(`${origin}/auth/session`);
  assert.equal(session.status(), 200);
  const { csrfToken } = await session.json();
  assert.equal(typeof csrfToken, "string");
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
        await pending.guest.getByText("The host declined your request to join.", { exact: true }).waitFor({ timeout: 15000 });
      }
    } finally {
      await pending.context.close();
    }
  }
  const abandoned = await knock("Uncollected guest");
  await abandoned.context.close();
  await page.getByRole("button", { name: "Admit Uncollected guest", exact: true }).click();
  await waitForSql(`select status from sync_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Uncollected guest'`, "admitted");
  await promisify(execFile)("psql", [
    process.env.CHALK_DATABASE_URL,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `update sync_admission_requests set requested_at=now()-interval '6 minutes', expires_at=now()-interval '2 minutes', completed_at=now()-interval '2 minutes' where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Uncollected guest'`,
  ]);
  await waitForSql(
    `select participant.status from participants participant join sync_admission_requests request on request.tenant_id=participant.tenant_id and request.episode_id=participant.episode_id and request.participant_id=participant.id where request.tenant_id='${tenantId}' and request.space_id='${spaceId}' and request.display_name='Uncollected guest'`,
    "left",
  );
  await page.screenshot({ path: resolve(out, "after-uncollected-seat-removed.png") });

  await proveDashboardWithoutHost();

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
