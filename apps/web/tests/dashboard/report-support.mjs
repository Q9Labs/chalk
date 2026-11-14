import { execFileSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

/** Helpers for the report proof. `c` is the proof's context: the pages, the evidence folder and the fake webhook. */
export async function checkGuestRegression(c, name, check) {
  const { evidence, regressions } = c;
  try {
    await check();
    regressions.push({ name, passed: true });
  } catch (error) {
    regressions.push({ name, passed: false, error: String(error) });
  }
  await writeFile(resolve(evidence, "guest-regressions.json"), JSON.stringify(regressions, null, 2));
}

export async function received(c) {
  const { webhook } = c;
  return (await fetch(`${webhook}/reports`)).json();
}

function deliveryRecords() {
  return JSON.parse(
    execFileSync(
      "psql",
      [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-Atqc", "select coalesce(json_agg(json_build_object('event_id',event_id,'journey_id',journey_id,'name',name,'state',state,'attributes',attributes)), '[]'::json) from observability_journey_events where name='problem_report.delivered'"],
      { encoding: "utf8" },
    ),
  );
}

export async function submit(c, tab, { name, diagnostics = true, failure = false }) {
  const { call, evidence, label, webhook } = c;
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
  const reports = await received(c);
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
