import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
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
  async function holdParticipant(name) {
    const child = spawn("psql", [process.env.CHALK_DATABASE_URL, "-X", "-qAt", "-v", "ON_ERROR_STOP=1"], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let error = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      error += chunk;
    });
    child.stdin.write(`begin; select p.id from participants p join sync_admission_requests r on r.tenant_id=p.tenant_id and r.participant_id=p.id where r.tenant_id='${tenantId}' and r.space_id='${spaceId}' and r.display_name='${name}' for update of p;\n\\echo PARTICIPANT_BARRIER_READY\n`);
    for (let attempt = 0; attempt < 100 && !output.includes("PARTICIPANT_BARRIER_READY"); attempt++) {
      if (child.exitCode !== null) throw new Error(`participant barrier exited: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!output.includes("PARTICIPANT_BARRIER_READY")) {
      child.kill("SIGTERM");
      throw new Error("participant barrier did not become ready");
    }
    return async () => {
      const done = new Promise((resolve, reject) => {
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`participant barrier exit ${code}: ${error}`))));
      });
      child.stdin.end("commit;\n");
      await done;
    };
  }
  async function proveInvalidationTick() {
    assert.equal(process.env.CHALK_DEADLINE_SCHEDULER_INTERVAL_MS, "3600000", "Automatic deadline ticks must be disabled for the one-tick witness");
    const dashboard = await page.context().newPage();
    await dashboard.goto(`${origin}/dashboard/call/${spaceId}`);
    await dashboard.getByRole("link", { name: "Join call", exact: true }).waitFor();
    const pending = await knock("Rotated invite guest", true);
    try {
      const row = dashboard.locator(".orow").filter({ hasText: "Rotated invite guest" });
      await row.getByRole("button", { name: "Let in", exact: true }).waitFor();
      const handle = await sql(`select request_handle from space_public_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Rotated invite guest'`);
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
  async function proveDashboardDecisionRetry() {
    const dashboard = await page.context().newPage();
    await dashboard.goto(`${origin}/dashboard/call/${spaceId}`);
    await dashboard.getByRole("link", { name: "Join call", exact: true }).waitFor();
    const marker = crypto.randomUUID();
    await dashboard.evaluate((value) => {
      window.admissionProofDocument = value;
    }, marker);
    const pending = await knock("Retryable dashboard guest", true);
    let decisions = 0;
    const countDecision = (request) => {
      if (new URL(request.url()).pathname === "/dashboard-api/call" && request.method() === "POST" && request.postDataJSON()?.action === "approve-knock") decisions++;
    };
    dashboard.on("request", countDecision);
    const removeHold = async () => {
      await promisify(execFile)("psql", [process.env.CHALK_DATABASE_URL, "-X", "-v", "ON_ERROR_STOP=1", "-c", "drop trigger if exists proof_hold_admission_decision on sync_external_operations; drop function if exists proof_hold_admission_decision();"]);
    };
    try {
      const row = dashboard.locator(".orow").filter({ hasText: "Retryable dashboard guest" });
      await row.getByRole("button", { name: "Let in", exact: true }).waitFor();
      const handle = await sql(`select request_handle from space_public_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Retryable dashboard guest'`);
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
      await waitForSql(`select count(*) from sync_admission_requests where admission_request_id='${handle}' and decision_external_operation_id is not null`, "1");
      const { stdout } = await promisify(execFile)("mix", ["run", "--no-start", "scripts/proof-fail-admission.exs"], { cwd: resolve(repository, "apps/sync"), env: { ...process.env, CHALK_PROOF_FAILED_REQUEST: handle }, timeout: 60000 });
      await writeFile(resolve(out, "dashboard-sync-failure.log"), stdout);
      await waitForSql(
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
  async function proveDashboardWithoutHost() {
    await page.getByRole("button", { name: "Leave call", exact: true }).click();
    await page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
    await page.waitForURL(`${origin}/dashboard/call/${spaceId}`);
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
      const release = await holdParticipant("Hostless dashboard guest");
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
        assert.equal(await sql(activeSeats), "0", "Participant lock must hold actual Sync finalisation, not just the browser response");
        assert.equal(await sql(`select state from space_public_admission_requests where tenant_id='${tenantId}' and space_id='${spaceId}' and display_name='Hostless dashboard guest'`), "pending", "The database finalisation is still delayed through all four polls");
        await page.screenshot({ path: resolve(out, "after-dashboard-inflight-row-disabled.png") });
        await writeFile(resolve(out, "dashboard-delayed-finalisation.json"), JSON.stringify({ successfulPollsBeforeRelease: polls, decisions, inFlightRowStayedDisabled: true, activeSeatsBeforeRelease: 0 }, null, 2));
      } finally {
        page.off("response", countPoll);
        page.off("request", countDecision);
        await release();
      }
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
  if (process.argv.includes("--admission-dashboard-retry")) {
    await proveDashboardDecisionRetry();
    return;
  }
  if (process.argv.includes("--admission-invalidation")) {
    await proveInvalidationTick();
    return;
  }
  if (process.argv.includes("--admission-dashboard-before") || process.argv.includes("--admission-dashboard-readded-before")) {
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
