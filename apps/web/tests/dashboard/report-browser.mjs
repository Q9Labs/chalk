import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { checkReportTransitions } from "./report-transitions.mjs";
import { guestReports } from "./report-guest.mjs";
import { expiredOwner, homeChecks, ownerReport, policyChecks } from "./report-owner.mjs";
import { received } from "./report-support.mjs";

// Called by the real-engine + dashboard join harness. Nothing substitutes the
// app, API, signed call credentials, database, or Sync; only Discord is local.
export async function checkReports({ browser, page, origin, call, repository }) {
  const evidence = resolve(repository, "artifacts/report-discord");
  await mkdir(evidence, { recursive: true });
  const webhook = process.env.CHALK_REPORT_FAKE_ORIGIN;
  assert(webhook, "Run with report-proof.mjs");
  const label = process.env.CHALK_REPORT_LIVE_PROOF === "1" ? "TEST from Chalk report-discord PR, ignore" : "Report browser proof";
  const c = { browser, page, origin, call, repository, evidence, regressions: [], label, webhook, csrfToken: undefined };
  await homeChecks(c);
  const video = page.video();
  if (video) await writeFile(resolve(evidence, "owner-video-name.txt"), basename(await video.path()));
  await ownerReport(c);
  if (process.env.CHALK_REPORT_LIVE_PROOF === "1") {
    assert.equal((await received(c)).length, 1, "Exactly one live test message");
    await writeFile(resolve(evidence, "live-proof.json"), JSON.stringify({ result: "passed", messages: 1, label }));
    return;
  }
  const session = await page.context().request.get(`${origin}/auth/session`);
  assert.equal(session.status(), 200);
  c.csrfToken = (await session.json()).csrfToken;
  const opened = await page.context().request.post(`${origin}/dashboard-api/call`, { headers: { Origin: origin, "X-CSRF-Token": c.csrfToken }, data: { action: "set-admission", spaceId: call.call.id, admission: "anyone" } });
  assert.equal(opened.status(), 200, await opened.text());
  await guestReports(c);
  await policyChecks(c);
  await checkReportTransitions({ browser, page, origin, call, csrfToken: c.csrfToken, evidence });
  await expiredOwner(c);
  await writeFile(resolve(evidence, "browser-proof.json"), JSON.stringify({ result: "passed", reports: (await received(c)).length, paths: ["OwnerCall dropdown", "SpacePage dropdown", "left screen", "failed screen"] }));
}
