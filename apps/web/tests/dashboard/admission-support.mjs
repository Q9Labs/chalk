import { strict as assert } from "node:assert";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Helpers for the public-admission proof. `c` is the proof's context: the browsers, ids and evidence it collects. */
export async function sql(c, query) {
  const { stdout } = await promisify(execFile)("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-At", "-c", query]);
  return stdout.trim();
}

export async function terminalProjection(c, name, state) {
  const { tenantId, spaceId, terminalLedger } = c;
  const evidence = JSON.parse(
    await sql(
      c,
      `select json_build_object('state', public.state, 'journeyId', operation.journey_id, 'traceId', operation.producing_trace_id, 'ledgerEventId', root.event_id) from space_public_admission_requests public join sync_admission_requests live on live.admission_request_id=public.request_handle join sync_external_operations operation on operation.tenant_id=live.tenant_id and operation.external_operation_id=live.decision_external_operation_id join observability_journey_events root on root.event_id=operation.parent_journey_event_id and root.journey_id=operation.journey_id where public.tenant_id='${tenantId}' and public.space_id='${spaceId}' and public.display_name='${name}'`,
    ),
  );
  assert.equal(evidence.state, state);
  assert(evidence.journeyId && evidence.ledgerEventId, "Terminal decision retains its durable journey ledger");
  if (process.env.CHALK_API_OTLP_ENDPOINT) assert(evidence.traceId, "Instrumented terminal decision retains its producing trace");
  terminalLedger.push({ name, ...evidence });
  assert.equal(
    await sql(c, `select public.state from space_public_admission_requests public join sync_admission_requests live on live.admission_request_id=public.request_handle where public.tenant_id='${tenantId}' and public.space_id='${spaceId}' and public.display_name='${name}'`),
    state,
    "Sync commits the public terminal projection, removing it from the pending index",
  );
}

export async function waitForSql(c, query, expected) {
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await sql(c, query)) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.equal(await sql(c, query), expected);
}

export async function knock(c, name, dashboard = false) {
  const { browser, page, tenantId, spaceId, guestUrl, out, journeys } = c;
  const journeyId = crypto.randomUUID();
  const traceId = crypto.randomUUID().replaceAll("-", "");
  const context = await browser.newContext({
    extraHTTPHeaders: {
      "x-chalk-journey-id": journeyId,
      traceparent: `00-${traceId}-0123456789abcdef-01`,
    },
    viewport: { width: 1200, height: 850 },
    recordVideo: {
      dir: resolve(out, `after-${name.toLowerCase().replaceAll(" ", "-")}-video`),
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
  guest.on("response", (response) => {
    if (response.status() >= 400 && failures.length < 100) failures.push({ path: new URL(response.url()).pathname, status: response.status() });
  });
  try {
    await guest.goto(guestUrl);
    await guest.getByLabel("Your name").fill(name);
    await guest.getByRole("button", { name: "Join call", exact: true }).click();
    await guest.getByText(/Asking to join/).waitFor();
    if (dashboard) return { context, guest, failures };
    await page.getByRole("button", { name: `Let ${name} in`, exact: true }).waitFor({ timeout: 15000 });
    const badge = page.getByLabel("1 waiting to join", { exact: true });
    await badge.waitFor();
    assert.equal(await page.getByRole("tab", { name: /^People/ }).getAttribute("aria-selected"), "true", "A public knock opens People automatically");
    assert.equal(
      await sql(
        c,
        `select count(*) from sync_admission_requests admission join sync_lifecycle_intents intent on intent.tenant_id=admission.tenant_id and intent.episode_id=admission.episode_id and intent.intent_name='admission_requested' and intent.payload->>'admission_request_id'=admission.admission_request_id::text join observability_journey_events root on root.event_id=intent.parent_journey_event_id where admission.tenant_id='${tenantId}' and admission.space_id='${spaceId}' and admission.display_name='${name}' and intent.journey_id='${journeyId}' and intent.producing_trace_id='${traceId}' and intent.status='applied' and root.journey_id=intent.journey_id`,
      ),
      "1",
      "The HTTP journey and W3C trace reach the durable admission intent and ledger root",
    );
    journeys.push({ name, journeyId, traceId });
    return { context, guest, failures };
  } catch (error) {
    await writeFile(resolve(out, "failure-guest-network.json"), JSON.stringify(failures, null, 2));
    await page.screenshot({ path: resolve(out, "failure-host.png") });
    await guest.screenshot({ path: resolve(out, "failure-guest.png") });
    await context.close();
    throw error;
  }
}

export async function holdParticipant(c, name) {
  const { tenantId, spaceId } = c;
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
