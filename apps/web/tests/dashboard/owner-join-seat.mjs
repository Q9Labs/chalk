import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { proveServerSeats } from "./owner-seat-api.mjs";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

const fixture = await createDashboardProofFixture({ recordingName: "owner-seat-dashboard.webm", devicesMissing: true });
const { apiOrigin, origin, syncOrigin, repository, context, tenantId, bindings, syncLog, pagesLog, cleanup } = fixture;
try {
  let page = await context.newPage();
  fixture.recordPage(page);
  const sockets = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  const evidence = [];
  const sql = (query) => execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-Atc", query], { encoding: "utf8" }).trim();
  try {
    context.on("response", async (response) => {
      if (response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "join" && response.status() === 200) {
        const grant = (await response.json()).access;
        evidence.push({ event: "admitted", at: new Date().toISOString(), subject: grant.subject });
      }
    });
    let blockSync = true;
    await page.routeWebSocket(`${syncOrigin}*`, (socket) => {
      // Retained incident evidence: HTTP admission succeeded, but no hello
      // reached Sync. Hold the connection before forwarding any server frames.
      // This proves the durable-seat failure, not the unknown Windows cause.
      if (!blockSync) socket.connectToServer();
    });
    await page.goto(`${origin}/dashboard`);
    await page.getByRole("button", { name: "Start a call", exact: true }).click();
    await page.getByRole("button", { name: "Join call", exact: true }).click();
    await page.getByRole("button", { name: "Try again", exact: true }).waitFor({ timeout: 65000 });
    const spaceId = new URL(page.url()).pathname.split("/").at(-2);
    await page.screenshot({ path: resolve(repository, "artifacts/owner-seat-1-failed.png") });
    evidence.push({ event: "failed-ui", body: await page.locator("body").innerText(), capture: await page.evaluate(() => globalThis.__captureCalls), reloadMarker: await page.evaluate(() => sessionStorage.getItem("chalk.reload-rejoin")) });
    const callBefore = await context.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`);
    const failedCall = await callBefore.json();
    evidence.push({ event: "call-after-failed", data: failedCall });
    assert.equal(failedCall.live?.count ?? 0, 0, "blocked Sync must not count as a live participant");
    assert.equal(failedCall.episodes.find((episode) => episode.id === failedCall.live.id)?.participantCount, 0, "blocked Sync must not stamp attendance");
    const failedParticipant = evidence.find((entry) => entry.event === "admitted").subject.participant_id;
    assert.equal(sql(`select p.status||':'||s.state from participants p join participant_join_seats s on s.participant_id=p.id where p.id='${failedParticipant}'`), "left:cancelled", "the browser SDK must durably cancel failed startup over authenticated HTTP");
    const retryGrant = page.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "join" && response.status() === 200);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await retryGrant;
    await page.getByRole("button", { name: "Try again", exact: true }).waitFor({ timeout: 65000 });
    evidence.push({ event: "same-page-retry", capture: await page.evaluate(() => globalThis.__captureCalls) });
    const joinUrl = page.url();
    blockSync = false;
    await page.goto(`${origin}/dashboard`);
    await page.goto(joinUrl);
    await page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
    await delay(1500);
    await page.screenshot({ path: resolve(repository, "artifacts/owner-seat-reopened.png") });
    const callAfter = await context.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`);
    evidence.push({ event: "call-after-tab-reopen", data: await callAfter.json(), capture: await page.evaluate(() => globalThis.__captureCalls), body: await page.locator("body").innerText() });
    await writeFile(resolve(repository, "artifacts/owner-seat-repro.json"), JSON.stringify(evidence, null, 2));
    assert.equal(evidence.filter((e) => e.event === "admitted").length, 3);
    const seats = evidence.filter((e) => e.event === "admitted").map((e) => e.subject.participant_id);
    assert.equal(seats[0], seats[1]);
    assert.equal(seats[0], seats[2], "reopen in the same tab must retain the unresolved join identity");
    assert.equal(execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-Atc", `select count(*) from participants where space_id='${spaceId}'`], { encoding: "utf8" }).trim(), "1");
    const live = (await (await context.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`)).json()).live;
    assert.equal(live.count, 1, "normal join counts once");
    const abandoned = await context.newPage();
    await abandoned.routeWebSocket(`${syncOrigin}*`, () => {});
    await abandoned.route("**/cancel-join", (route) => route.abort());
    await abandoned.goto(`${origin}/dashboard`);
    const unknownJoinKey = crypto.randomUUID();
    await abandoned.evaluate(
      ({ spaceId, unknownJoinKey }) => {
        sessionStorage.setItem(`chalk.owner-join:${spaceId}`, unknownJoinKey);
        sessionStorage.removeItem(`chalk.owner-join:${spaceId}:episode`);
      },
      { spaceId, unknownJoinKey },
    );
    const admissionResponse = abandoned.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "join" && response.status() === 200);
    await abandoned.goto(joinUrl);
    const admittedResponse = await admissionResponse;
    assert.notEqual(admittedResponse.request().postDataJSON().idempotencyKey, unknownJoinKey, "an unknown Episode must not reuse an old stored join key");
    const abandonedId = (await admittedResponse.json()).access.subject.participant_id;
    await abandoned.close();
    assert.equal(sql(`select (first_joined_at is not null)::text from participants where id='${abandonedId}'`), "false", "closing the tab after HTTP admission must not create attendance");
    sql(`update participant_join_seats set expires_at=now()-interval '1 second' where participant_id='${abandonedId}'; update sync_lifecycle_intents set next_attempt_at=now() where participant_id='${abandonedId}' and status='pending'`);
    for (let attempt = 0; attempt < 100 && sql(`select status from participants where id='${abandonedId}'`) !== "left"; attempt++) await delay(50);
    assert.equal(sql(`select state from participant_join_seats where participant_id='${abandonedId}'`), "expired");
    console.log("PASS actual tab closed after HTTP admission, cleanup blocked, lease reaped with no attendance");
    await proveServerSeats({ repository, apiOrigin, syncOrigin, tenantId });
    console.log("PASS dashboard pending cleanup, Retry, reopen and normal join", JSON.stringify(seats));
    console.log("PASS owner seat proof complete");
  } catch (error) {
    await page.screenshot({ path: resolve(repository, "artifacts/owner-seat-error.png") });
    await writeFile(resolve(repository, "artifacts/owner-seat-failure.log"), JSON.stringify({ evidence, body: await page.locator("body").innerText(), sync: syncLog.join(""), pages: pagesLog.join("") }));
    throw error;
  }
} finally {
  await cleanup();
}
