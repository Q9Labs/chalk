// Real API/Postgres/Sync + SDK in Chromium. Only vendor services are fixtures.
// Run through real-engine.sh; evidence contains only allowlisted report data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

const fixture = await createDashboardProofFixture({ devicesMissing: true, syncObservability: true });
const { context, origin, repository, syncLog } = fixture;
const output = resolve(repository, "artifacts/connection-reports");
await mkdir(output, { recursive: true });
const reports = [];
const statuses = [];
const expectedHashes = new Set();
let mode = "reject";
const forwarded = [];
const helloTraces = new Set();
try {
  const page = await context.newPage();
  page.on("request", (request) => {
    if (!request.url().endsWith("/connection-reports") || request.method() !== "POST") return;
    reports.push({ report: request.postDataJSON(), trace: request.headers().traceparent?.split("-")[1] });
  });
  page.on("response", async (response) => {
    if (response.url().endsWith("/connection-reports") && response.request().method() === "POST") statuses.push(response.status());
    if (response.url().endsWith("/dashboard-api/call") && response.request().method() === "POST") {
      const body = await response.json();
      const participant = body.access?.subject?.participant_id;
      if (participant) expectedHashes.add(createHash("sha256").update(participant).digest("hex"));
    }
  });
  await page.routeWebSocket(
    (url) => url.pathname === "/v1/sync",
    (socket) => {
      if (mode !== "live") {
        socket.close({ code: 1013, reason: "" });
        return;
      }
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (frame.type === "hello") helloTraces.add(frame.traceparent?.split("-")[1]);
        server.send(message);
      });
      forwarded.push({ socket, server });
    },
  );
  async function joinNewCall() {
    await page.goto(`${origin}/dashboard`);
    await page.getByRole("button", { name: "Start a call", exact: true }).click();
    await page.getByRole("button", { name: "Join call", exact: true }).click();
  }
  await joinNewCall();
  await page.locator('[data-chalk-status="failed"]').waitFor({ timeout: 60000 });
  await page
    .waitForResponse((response) => response.url().endsWith("/connection-reports") && response.status() === 204, { timeout: 10000 })
    .catch(() => {
      assert(statuses.includes(204), "join report was not accepted");
    });
  assert.equal(reports.length, 1);
  assert.equal(reports[0].report.trigger, "join_failed");
  assert(reports[0].report.events.some((event) => event.event === "space_join_span" && event.step === "access_initialize"));
  assert(reports[0].report.events.some((event) => event.event === "sync_socket_close" && event.close_code === 1013));
  assert(reports[0].report.events.some((event) => event.event === "connection_failed"));
  mode = "live";
  await joinNewCall();
  await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
  // One heartbeat round trip gives the drop a measured last-reply gap.
  await delay(22000);
  assert.equal(reports.length, 1, "successful call uploaded diagnostics");
  mode = "offline";
  const offlineStarted = performance.now();
  await context.setOffline(true);
  for (const { socket, server } of forwarded) {
    socket.close({ code: 1012, reason: "" });
    server.close({ code: 1012, reason: "" });
  }
  await page.getByRole("heading", { name: "Connection lost", exact: true }).waitFor({ timeout: 45000 });
  assert.equal(reports.length, 1, "offline report attempted a network upload");
  await delay(Math.max(0, 60000 - (performance.now() - offlineStarted)));
  const offlineMilliseconds = Math.round(performance.now() - offlineStarted);
  assert(offlineMilliseconds >= 60000);
  mode = "live";
  const received = page.waitForResponse((response) => response.url().endsWith("/connection-reports") && response.status() === 204);
  await context.setOffline(false);
  await received;
  assert.equal(reports.length, 2);
  const drop = reports[1];
  assert.equal(drop.report.trigger, "recovery_exhausted");
  assert(drop.report.events.some((event) => event.event === "recovery_attempt"));
  assert(drop.report.events.some((event) => event.event === "sync_socket_open"));
  assert(drop.report.events.some((event) => event.event === "sync_socket_close" && event.heartbeat_gap_ms != null));
  assert(helloTraces.has(drop.trace), "Sync hello and report did not share a trace");
  await page.getByRole("button", { name: "Rejoin", exact: true }).click();
  await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
  assert.equal(reports.length, 2, "rejoin uploaded another report");
  const apiLogs = (await readFile(resolve(repository, "artifacts/dashboard-api.log"), "utf8"))
    .split("\n")
    .filter((line) => line.includes('"event":"sdk.connection_report"'))
    .map((line) => JSON.parse(line));
  assert.equal(apiLogs.length, 2);
  for (const [index, line] of apiLogs.entries()) {
    assert.equal(line.trace_id, reports[index].trace);
    assert.match(line.trace_id, /^[0-9a-f]{32}$/);
    assert.notEqual(line.trace_id, "0".repeat(32));
    assert(expectedHashes.has(line.participant_id_hash), "server did not hash the verified participant");
    assert.deepEqual(JSON.parse(line.report), reports[index].report);
    assert(Buffer.byteLength(line.report) <= 32768);
    assert(JSON.parse(line.report).events.length <= 64);
    assert(!/eyJ|Bearer|@|192\.0\.2\.|stun:|wss?:\/\//u.test(line.report), "private data entered a report");
  }
  const syncEvidence = syncLog
    .join("")
    .split("\n")
    .filter((line) => line.includes("sync.websocket.closed") && line.includes(apiLogs[1].participant_id_hash));
  assert(syncEvidence.length > 0, "no matching #566 Sync close log");
  await writeFile(resolve(output, "api-reports.jsonl"), apiLogs.map((line) => JSON.stringify(line)).join("\n") + "\n");
  await writeFile(resolve(output, "sync-correlation.log"), syncEvidence.join("\n") + "\n");
  const result = { offlineMilliseconds, statuses, triggers: reports.map((entry) => entry.report.trigger), traces: reports.map((entry) => entry.trace), hashesMatched: true, realSyncHelloTraceMatched: true, rejoinVerified: true, reports };
  await writeFile(resolve(output, "proof.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, reports: undefined }));
} finally {
  await context.setOffline(false);
  await fixture.cleanup();
}
