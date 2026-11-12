import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { holdParticipant, knock, sql, terminalProjection, waitForSql } from "./admission-support.mjs";
import { writeFile } from "node:fs/promises";

export async function proveInvalidationTick(c) {
  const { page, origin, tenantId, spaceId, out } = c;
  assert.equal(process.env.CHALK_DEADLINE_SCHEDULER_INTERVAL_MS, "3600000", "Automatic deadline ticks must be disabled for the one-tick witness");
  const dashboard = await page.context().newPage();
  await dashboard.goto(`${origin}/dashboard/call/${spaceId}`);
  await dashboard.getByRole("link", { name: "Join call", exact: true }).waitFor();
  const pending = await knock(c, "Rotated invite guest", true);
  try {
    const row = dashboard.locator(".knock").filter({ hasText: "Rotated invite guest" });
    await row.getByRole("button", { name: "Let in", exact: true }).waitFor();
    const handle = await sql(c, `select request_handle from space_public_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Rotated invite guest'`);
    const session = await (await dashboard.request.get(`${origin}/auth/session`)).json();
    const rotated = await dashboard.request.post(`${origin}/dashboard-api/call`, { headers: { Origin: origin, "X-CSRF-Token": session.csrfToken }, data: { action: "rotate-link", spaceId, idempotencyKey: crypto.randomUUID() } });
    assert.equal(rotated.status(), 200, await rotated.text());
    await pending.guest.getByText("Your request to join expired or is no longer available.", { exact: true }).waitFor({ timeout: 15000 });
    try {
      const { stdout } = await promisify(execFile)("go", ["test", "-C", "apps/api", "-vet=off", "./internal/adapters/postgres", "-run", "^TestPublicAdmissionInvalidationOneSchedulerTick$", "-v", "-count=1"], {
        cwd: repository,
        env: { ...process.env, CHALK_PROOF_INVALIDATED_REQUEST: handle },
        timeout: 60000,
      });
      await writeFile(resolve(out, "invalidation-one-tick.log"), stdout);
    } catch (error) {
      await writeFile(resolve(out, "invalidation-one-tick.log"), `${error.stdout ?? ""}\n${error.stderr ?? ""}`);
      await dashboard.screenshot({ path: resolve(out, "before-invalidated-dashboard-knock.png") });
      throw error;
    }
    await row.waitFor({ state: "hidden", timeout: 10000 });
    await dashboard.screenshot({ path: resolve(out, "after-invalidated-dashboard-clear.png") });
    await writeFile(resolve(out, "invalidation-one-tick.json"), JSON.stringify({ schedulerTicks: 1, deadlineStillMoreThanFourMinutesAway: true, dashboardKnockRemoved: true, reservationReleased: true, guestUnavailable: true }, null, 2));
    console.log("PASS: rotate waiting invite → guest unavailable → one scheduler tick → dashboard knock removed and reservation released before deadline");
  } finally {
    await pending.context.close();
    await dashboard.close();
  }
}

export async function proveDashboardDecisionRetry(c) {
  const { page, origin, tenantId, spaceId, out } = c;
  const dashboard = await page.context().newPage();
  await dashboard.goto(`${origin}/dashboard/call/${spaceId}`);
  await dashboard.getByRole("link", { name: "Join call", exact: true }).waitFor();
  const marker = crypto.randomUUID();
  await dashboard.evaluate((value) => {
    window.admissionProofDocument = value;
  }, marker);
  const pending = await knock(c, "Retryable dashboard guest", true);
  let decisions = 0;
  const countDecision = (request) => {
    if (new URL(request.url()).pathname === "/dashboard-api/call" && request.method() === "POST" && request.postDataJSON()?.action === "approve-knock") decisions++;
  };
  dashboard.on("request", countDecision);
  const removeHold = async () => {
    await promisify(execFile)("psql", [process.env.CHALK_DATABASE_URL, "-X", "-v", "ON_ERROR_STOP=1", "-c", "drop trigger if exists proof_hold_admission_decision on sync_external_operations; drop function if exists proof_hold_admission_decision();"]);
  };
  try {
    const row = dashboard.locator(".knock").filter({ hasText: "Retryable dashboard guest" });
    await row.getByRole("button", { name: "Let in", exact: true }).waitFor();
    const handle = await sql(c, `select request_handle from space_public_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Retryable dashboard guest'`);
    // Prevent the existing consumer from applying this one operation before
    // the proof delivers its terminal outcome through Sync's real finalizer.
    await promisify(execFile)("psql", [
      process.env.CHALK_DATABASE_URL,
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `create function proof_hold_admission_decision() returns trigger language plpgsql as $$ begin if new.operation_name='admit_participant' and new.payload->>'admissionRequestId'='${handle}' then new.next_attempt_at=now()+interval '1 hour'; end if; return new; end $$; create trigger proof_hold_admission_decision before insert on sync_external_operations for each row execute function proof_hold_admission_decision();`,
    ]);
    await row.getByRole("button", { name: "Let in", exact: true }).click();
    await waitForSql(c, `select count(*) from sync_admission_requests where admission_request_id='${handle}' and decision_external_operation_id is not null`, "1");
    const { stdout } = await promisify(execFile)("mix", ["run", "--no-start", "scripts/proof-fail-admission.exs"], { cwd: resolve(repository, "apps/sync"), env: { ...process.env, CHALK_PROOF_FAILED_REQUEST: handle }, timeout: 60000 });
    await writeFile(resolve(out, "dashboard-sync-failure.log"), stdout);
    await waitForSql(
      c,
      `select count(*) from sync_admission_requests request join sync_external_operations operation on operation.tenant_id=request.tenant_id and operation.episode_id=request.episode_id and operation.payload->>'admissionRequestId'=request.admission_request_id::text where request.admission_request_id='${handle}' and request.status='pending' and request.decision_external_operation_id is null and operation.status='failed'`,
      "1",
    );
    try {
      await row.getByRole("button", { name: "Let in", exact: true }).waitFor({ timeout: 15000 });
      assert.equal(await row.getByRole("button", { name: "Let in", exact: true }).isEnabled(), true);
    } catch (error) {
      await dashboard.screenshot({ path: resolve(out, "before-dashboard-failed-decision-stuck.png") });
      throw new Error("Failed dashboard decision did not become actionable from server truth", { cause: error });
    }
    assert.equal(await dashboard.evaluate(() => window.admissionProofDocument), marker, "Retry became actionable without reloading the dashboard document");
    await dashboard.screenshot({ path: resolve(out, "after-dashboard-failed-decision-retryable.png") });
    await removeHold();
    await row.getByRole("button", { name: "Let in", exact: true }).click();
    await pending.guest.getByTestId("stage").waitFor({ timeout: 20000 });
    await row.waitFor({ state: "hidden", timeout: 15000 });
    assert.equal(decisions, 2, "The host submits exactly the accepted decision and its explicit retry");
    await pending.guest.screenshot({ path: resolve(out, "after-dashboard-retried-guest-admitted.png") });
    await writeFile(resolve(out, "dashboard-decision-retry.json"), JSON.stringify({ syncFailedAcceptedDecision: true, reservationReleased: true, serverRestoredActionableRow: true, documentReloaded: false, explicitDecisions: decisions, guestAdmittedAfterRetry: true }, null, 2));
    await pending.guest.getByRole("button", { name: "Leave call", exact: true }).click();
    await pending.guest.getByRole("heading", { name: /You left/ }).waitFor();
    console.log("PASS: accepted dashboard decision → actual Sync failure → next server list enables retry → host retries → guest admitted without refresh");
  } finally {
    dashboard.off("request", countDecision);
    await removeHold();
    await pending.context.close();
    await dashboard.close();
  }
}

export async function proveDashboardWithoutHost(c) {
  const { page, origin, tenantId, spaceId, out } = c;
  await page.getByRole("button", { name: "Leave call", exact: true }).click();
  await page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
  await page.waitForURL(`${origin}/dashboard/call/${spaceId}`);
  const activeSeats = `select count(*) from participants p join episodes e on e.tenant_id=p.tenant_id and e.id=p.episode_id where e.tenant_id='${tenantId}' and e.space_id='${spaceId}' and p.status='active'`;
  await waitForSql(c, activeSeats, "0");
  await page.goto(`${origin}/dashboard/call/${spaceId}`);
  await page.getByRole("link", { name: "Join call", exact: true }).waitFor();
  const dashboardDocument = crypto.randomUUID();
  await page.evaluate((marker) => {
    window.admissionProofDocument = marker;
  }, dashboardDocument);
  const pending = await knock(c, "Hostless dashboard guest", true);
  try {
    const guestDocument = crypto.randomUUID();
    await pending.guest.evaluate((marker) => {
      window.admissionProofDocument = marker;
    }, guestDocument);
    const row = page.locator(".knock").filter({ hasText: "Hostless dashboard guest" });
    try {
      await row.getByRole("button", { name: "Let in", exact: true }).waitFor({ timeout: 15000 });
    } catch (error) {
      await page.screenshot({ path: resolve(out, "before-dashboard-missing-knock.png") });
      await pending.guest.screenshot({ path: resolve(out, "before-dashboard-guest-waiting.png") });
      throw error;
    }
    assert.equal(await sql(c, `select count(*) from episodes where tenant_id='${tenantId}' and space_id='${spaceId}' and status='active'`), "1", "Approval targets an existing live Episode");
    assert.equal(await sql(c, activeSeats), "0", "Dashboard approval has no connected host or participant");
    assert.equal(await page.evaluate(() => window.admissionProofDocument), dashboardDocument, "Knock appeared without dashboard document reload");
    await page.screenshot({ path: resolve(out, "after-dashboard-live-knock.png") });
    const release = await holdParticipant(c, "Hostless dashboard guest");
    let polls = 0;
    let decisions = 0;
    const countPoll = (response) => {
      if (new URL(response.url()).pathname === "/dashboard-api/call-status" && response.request().method() === "GET" && response.status() === 200) polls++;
    };
    const countDecision = (request) => {
      if (new URL(request.url()).pathname === "/dashboard-api/call" && request.method() === "POST" && request.postDataJSON()?.action === "approve-knock") decisions++;
    };
    page.on("response", countPoll);
    page.on("request", countDecision);
    try {
      await row.getByRole("button", { name: "Let in", exact: true }).click();
      await row.getByRole("button", { name: "Letting in…", exact: true }).waitFor();
      for (let attempt = 0; attempt < 200 && polls < 4; attempt++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert(polls >= 4, "Delayed finalisation witness needs at least four successful list polls");
      assert.equal(await row.count(), 1, "An accepted dashboard decision remains visible while Sync finalisation is pending");
      assert.equal(await row.getByRole("button", { name: "Letting in…", exact: true }).isDisabled(), true);
      assert.equal(await row.getByRole("button", { name: "Deny", exact: true }).isDisabled(), true);
      assert.equal(decisions, 1, "A delayed accepted decision must not be submitted twice");
      assert.equal(await sql(c, activeSeats), "0", "Participant lock must hold actual Sync finalisation, not just the browser response");
      assert.equal(await sql(c, `select state from space_public_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Hostless dashboard guest'`), "pending", "The database finalisation is still delayed through all four polls");
      await page.screenshot({ path: resolve(out, "after-dashboard-inflight-row-disabled.png") });
      await writeFile(resolve(out, "dashboard-delayed-finalisation.json"), JSON.stringify({ successfulPollsBeforeRelease: polls, decisions, inFlightRowStayedDisabled: true, activeSeatsBeforeRelease: 0 }, null, 2));
    } finally {
      page.off("response", countPoll);
      page.off("request", countDecision);
      await release();
    }
    try {
      // The barrier forces a finalization failure; its durable claim is retried after 60 seconds.
      await pending.guest.getByTestId("stage").waitFor({ timeout: 90000 });
      await pending.guest.getByRole("group", { name: "Stage with 1 participant", exact: true }).waitFor({ timeout: 15000 });
    } catch (error) {
      await pending.guest.screenshot({ path: resolve(out, "hostless-failure-guest.png") });
      const state = await sql(
        c,
        `select json_agg(json_build_object('admission', r.status, 'participant', p.status, 'arrival', a.state, 'public', public.state, 'operation', op.status, 'attempts', op.attempt_count, 'error', op.last_error_code)) from sync_admission_requests r join participants p on p.id=r.participant_id join space_public_admission_requests public on public.request_handle=r.admission_request_id join space_public_arrivals a on a.arrival_handle=public.arrival_handle left join sync_external_operations op on op.external_operation_id=r.decision_external_operation_id where r.tenant_id='${tenantId}' and r.space_id='${spaceId}' and r.display_name='Hostless dashboard guest'`,
      );
      await writeFile(resolve(out, "hostless-failure.json"), JSON.stringify({ body: await pending.guest.locator("body").innerText(), failures: pending.failures, state: JSON.parse(state) }, null, 2));
      throw error;
    }
    assert.equal(await pending.guest.evaluate(() => window.admissionProofDocument), guestDocument, "Guest entered automatically without document reload");
    assert.equal(await page.evaluate(() => window.admissionProofDocument), dashboardDocument);
    await row.waitFor({ state: "hidden" });
    await pending.guest.screenshot({ path: resolve(out, "after-dashboard-hostless-guest-admitted.png") });
    await terminalProjection(c, "Hostless dashboard guest", "approved");
    await writeFile(resolve(out, "dashboard-live-acceptance.json"), JSON.stringify({ dashboardKnockWithoutReload: true, connectedParticipantsBeforeApproval: 0, liveEpisodesBeforeApproval: 1, dashboardLetIn: true, guestStageParticipants: 1, guestEnteredWithoutRefresh: true }, null, 2));
    await pending.guest.getByRole("button", { name: "Leave call", exact: true }).click();
    await pending.guest.getByRole("heading", { name: /You left/ }).waitFor();
    console.log("PASS: already-open dashboard receives a live knock without reload → Let in with zero connected hosts → guest enters the one-person stage without refresh");
  } finally {
    await pending.context.close();
  }
}
