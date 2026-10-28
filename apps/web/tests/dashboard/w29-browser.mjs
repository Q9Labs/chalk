import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { createConnection, createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";
import { build } from "../../../../tools/sdk-web-consumer-e2e/node_modules/esbuild/lib/main.js";

const fixture = await createDashboardProofFixture({ devicesMissing: true, syncObservability: true });
const { context, repository, apiOrigin, origin, syncOrigin, tenantId, syncLog } = fixture;
const out = resolve(repository, "artifacts/w29");
await mkdir(out, { recursive: true });
const { createChalkServerClient } = await import(`${repository}/sdks/typescript/client/dist/server/index.js`);
const server = createChalkServerClient({ apiBaseURL: apiOrigin, tenantId, apiKey: "fixture-dashboard-service-token-not-a-secret" });
const space = await server.spaces.create({ admissionPolicy: { mode: "open" }, defaultEpisodeDurationSeconds: 3600, lingerWindowSeconds: 60, maximumEpisodeDurationSeconds: 3600, mediaPlane: "cf_sfu", name: "Synthetic W29", slug: `w29-${crypto.randomUUID()}`, recordingPolicy: "disabled" });
const episode = await server.episodes.create(space.id, {}, { idempotencyKey: crypto.randomUUID() });
const results = [];
const sockets = new Set();
let fault = "reset";
let dial = 0;
const network = createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  if (fault === "reset") socket.destroy();
  if (fault === "stall_first" && ++dial > 1) {
    const upstream = createConnection({ host: "127.0.0.1", port: Number(new URL(syncOrigin).port) });
    sockets.add(upstream);
    upstream.once("close", () => sockets.delete(upstream));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.pipe(upstream).pipe(socket);
  }
});
await new Promise((accept) => network.listen(0, "127.0.0.1", accept));
const faultURL = `ws://127.0.0.1:${network.address().port}/v1/sync`;
const sql = (query) => execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-Atc", query], { encoding: "utf8" }).trim();
const hash = (id) => createHash("sha256").update(id).digest("hex");
async function participant() {
  const admitted = await server.participants.admit(space.id, episode.id, { participantId: crypto.randomUUID(), name: "Synthetic W29", role: "collaborator" }, { idempotencyKey: crypto.randomUUID() });
  assert(admitted.access);
  return { id: admitted.participant.id, access: admitted.access, created: Date.now() };
}
async function pageFor(bundle, seat, { hold = 0, initialGrant = true, clockAhead = false } = {}) {
  const page = await context.newPage();
  if (clockAhead) await page.addInitScript(() => { const actualNow = Date.now; Date.now = () => actualNow() + 360000; });
  const grants = [];
  let current = seat.access;
  let initial = initialGrant;
  await page.exposeBinding("access", async (_source, request) => {
    if (initial) { initial = false; return current; }
    const at = Date.now();
    current = await server.participants.issueAccess(space.id, episode.id, seat.id, { participantGeneration: current.subject.participant_generation, currentMediaToken: current.media.token }, { replaceMediaConnection: request.replaceMediaConnection ?? false });
    grants.push({ at, status: 201, participant_hash: hash(seat.id) });
    if (hold) await delay(hold);
    return request.preparation ? { kind: "ready", access: current, space: space.slug, displayName: "Synthetic", spaceName: "Synthetic", diagnosticReference: "synthetic", attendanceMode: "tracked", leaveCleanup: { endpoint: origin, token: "synthetic" } } : current;
  });
  await page.route(`${origin}/w29`, (route) => route.fulfill({ contentType: "text/html", body: '<div id="root"></div><script type="module" src="/w29-bundle.js"></script>' }));
  await page.route(`${origin}/w29-bundle.js`, (route) => route.fulfill({ contentType: "text/javascript", path: bundle }));
  await page.goto(`${origin}/w29`);
  await page.waitForFunction(() => Boolean(window.startClient));
  return { page, grants };
}
try {
  const oldRoot = resolve(out, "sdk520");
  const thSource = resolve(repository, "artifacts/w29-th-source.tsx");
  const thHash = hash(await readFile(thSource, "utf8"));
  const adapters = resolve(out, "th-adapters.jsx");
  await writeFile(adapters, `import React from "react";
export const api = { chalkActions: { getClassroomAccess: "access", handoffClassroom: "handoff", markOperationsEnded: "end", restartClassroom: "restart" } };
export class ConvexError extends Error {}
export function useSafeAction(name) { return React.useMemo(() => (args) => window.access({ ...args, preparation: true }), [name]); }
export function Chalk() { window.audit.push({ event: "unexpected_prepared_mount" }); return null; }
export function createSpaceClient() { window.audit.push({ event: "unexpected_prepared_client" }); throw Error("Unexpected prepared SDK client"); }
export const getUserErrorMessage = () => "Synthetic action failed";
export const chalkClientFailureMessage = () => "Synthetic client failed";
export const isChalkDeviceWarning = () => false;
export const chalkJoinFailure = (failure) => failure;
export const createChalkLeaveCleanupController = () => ({ handlePageHide() {} });
export const retainChalkClient = () => () => {};
export const superviseChalkWhiteboardController = (controller) => ({ controller, dispose() {} });
export const synchronizeChalkStaffDisplayName = () => {};
`);
  await mkdir(oldRoot, { recursive: true });
  const archive = execFileSync("git", ["archive", "a8cc69bb7", "sdks/typescript/client"]);
  execFileSync("tar", ["-x", "-C", oldRoot], { input: archive });
  await symlink(resolve(repository, "sdks/typescript/client/node_modules"), resolve(oldRoot, "sdks/typescript/client/node_modules"));
  for (const version of ["5.2.0", "775c0b991"]) {
    const bundle = resolve(out, `${version}.js`);
    const sdk = version === "5.2.0" ? resolve(oldRoot, "sdks/typescript/client/src/space-client/space-client.ts") : resolve(repository, "sdks/typescript/client/src/space-client/space-client.ts");
    await build({ absWorkingDir: resolve(repository, "apps/web"), entryPoints: ["tests/dashboard/w29-entry.jsx"], bundle: true, format: "esm", platform: "browser", outfile: bundle, nodePaths: [resolve(repository, "apps/web/node_modules")], alias: { "w29-sdk": sdk, "w29-th": thSource }, plugins: [{ name: "synthetic-th-boundaries", setup(build) { build.onResolve({ filter: /^(?:@shared-portal-ui\/|@convex\/|convex\/values$|@q9labsai\/chalk-(?:client|react)$)/u }, () => ({ path: adapters })); } }], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
    for (const mode of ["live", "reset", "stall", "stall_first", "slow_cpu", "clock_ahead"]) {
      const seat = await participant();
      const { page, grants } = await pageFor(bundle, seat, { clockAhead: mode === "clock_ahead" });
      fault = mode;
      dial = 0;
      const cdp = await context.newCDPSession(page);
      if (mode === "slow_cpu") await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
      const began = Date.now();
      await page.evaluate((options) => window.startClient(options), { space: space.slug, api: apiOrigin, sync: ["live", "slow_cpu", "clock_ahead"].includes(mode) ? syncOrigin : faultURL });
      await page.waitForFunction(() => window.audit.some((row) => row.event === "join_ok" || row.event === "join_failed"), null, { timeout: 45000 });
      const audit = await page.evaluate(() => window.audit);
      const result = { version, mode, elapsed_ms: Date.now() - began, grants, audit, seat: sql(`select p.status||':'||s.state||':'||(p.first_joined_at is not null)::text from participants p join participant_join_seats s on s.participant_id=p.id where p.id='${seat.id}'`) };
      if (mode === "live" || mode === "slow_cpu") assert(audit.some((row) => row.event === "join_ok"), JSON.stringify(result));
      results.push(result);
      console.log("W29_RESULT " + JSON.stringify(result));
      await page.evaluate(() => window.stopClient());
      await page.close();
      for (const socket of sockets) socket.destroy();
    }
    const seat = await participant();
    const { page, grants } = await pageFor(bundle, seat, { hold: 4500, initialGrant: false });
    const intervals = [2456, 1842, 3479, 1776, 2168, 1766];
    await page.evaluate(() => window.prepare());
    for (const interval of intervals) { await delay(interval); await page.evaluate(() => window.prepare()); }
    await delay(50);
    await page.evaluate(() => window.unmountPreparation());
    await delay(4600);
    const audit = await page.evaluate(() => window.audit);
    assert.equal(grants.length, 7);
    assert.equal(audit.filter((row) => row.event.startsWith("unexpected_prepared")).length, 0);
    assert.equal(audit.filter((row) => row.event === "socket_construct").length, 0);
    const result = { version, mode: "preparation_dependency_churn_delayed_response", th_source_sha256: thHash, grant_offsets_ms: grants.map((row) => row.at - grants[0].at), grants, audit, participant_hash: hash(seat.id), seat_before: sql(`select state from participant_join_seats where participant_id='${seat.id}'`) };
    if (version === "775c0b991") {
      await delay(Math.max(0, seat.created + 122000 - Date.now()));
      result.seat_after_122_seconds = sql(`select p.status||':'||s.state||':'||(p.first_joined_at is not null)::text from participants p join participant_join_seats s on s.participant_id=p.id where p.id='${seat.id}'`);
      try { await server.participants.issueAccess(space.id, episode.id, seat.id, { participantGeneration: seat.access.subject.participant_generation, currentMediaToken: seat.access.media.token }); }
      catch (error) { result.refresh_after_expiry = { status: error.status, code: error.code }; }
    }
    results.push(result);
    console.log("W29_RESULT " + JSON.stringify(result));
    await page.close();
  }
  const syncCounts = {};
  for (const line of syncLog.join("").split("\n")) { const match = line.match(/sync\.websocket\.(handshake|authenticated|closed)/u); if (match) syncCounts[match[0]] = (syncCounts[match[0]] ?? 0) + 1; }
  const report = { browser: fixture.browser.version(), server_revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sdk520_source: execFileSync("git", ["rev-parse", "a8cc69bb7"], { encoding: "utf8" }).trim(), syncCounts, results };
  await writeFile(resolve(out, "results.json"), JSON.stringify(report, null, 2));
  console.log("W29_FINAL " + JSON.stringify(report));
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise((accept) => network.close(accept));
  await fixture.cleanup();
}
