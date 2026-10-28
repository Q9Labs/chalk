import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDashboardProofFixture } from "./browser-fixture.mjs";
import { build } from "../../../../tools/sdk-web-consumer-e2e/node_modules/esbuild/lib/main.js";

const fixture = await createDashboardProofFixture({ devicesMissing: true, syncObservability: true });
const { browser, context, origin, repository, apiOrigin, syncOrigin, tenantId } = fixture;
const { createChalkServerClient } = await import(`${repository}/sdks/typescript/client/dist/server/index.js`);
const server = createChalkServerClient({ apiBaseURL: apiOrigin, tenantId, apiKey: "fixture-dashboard-service-token-not-a-secret" });
const output = resolve(repository, "artifacts/w29-rejoin");
await mkdir(output, { recursive: true });
const seats = new Map();
const history = [];
const network = [];
const sql = (query) => execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-Atc", query], { encoding: "utf8" }).trim();
let second;
try {
  const space = await server.spaces.create({ admissionPolicy: { mode: "open" }, defaultEpisodeDurationSeconds: 3600, lingerWindowSeconds: 60, maximumEpisodeDurationSeconds: 3600, mediaPlane: "cf_sfu", name: "Synthetic rejoin", slug: `rejoin-${crypto.randomUUID()}`, recordingPolicy: "disabled" });
  const episode = await server.episodes.create(space.id, {}, { idempotencyKey: crypto.randomUUID() });
  async function admit(label, principal, role = "collaborator") {
    const seat = await server.participants.admit(space.id, episode.id, { participantId: crypto.randomUUID(), name: principal, role, metadata: { syntheticPrincipal: principal } }, { idempotencyKey: crypto.randomUUID() });
    assert(seat.access);
    seats.set(label, seat);
    return seat;
  }
  const bundle = resolve(output, "entry.js");
  await build({ absWorkingDir: resolve(repository, "apps/web"), entryPoints: ["tests/dashboard/w29-rejoin-entry.mjs"], bundle: true, format: "esm", platform: "browser", outfile: bundle, define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  async function pageFor(profile, label) {
    await profile.grantPermissions(["local-network-access"], { origin });
    const page = await profile.newPage();
    await page.exposeBinding("access", async (_source, name, request) => {
      const seat = seats.get(name);
      if (seat.initialUsed) seat.access = await server.participants.issueAccess(space.id, episode.id, seat.participant.id, { participantGeneration: seat.access.subject.participant_generation, currentMediaToken: seat.access.media.token }, { replaceMediaConnection: request.replaceMediaConnection ?? false });
      seat.initialUsed = true;
      return seat.access;
    });
    await page.route(`${origin}/w29-rejoin`, (route) => route.fulfill({ contentType: "text/html", body: '<script type="module" src="/w29-rejoin.js"></script>' }));
    await page.route(`${origin}/w29-rejoin.js`, (route) => route.fulfill({ contentType: "text/javascript", path: bundle }));
    const cdp = await profile.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketHandshakeResponseReceived", ({ response }) => network.push({ profile: label, event: "upgrade", status: response.status }));
    cdp.on("Network.webSocketFrameError", ({ errorMessage }) => network.push({ profile: label, event: "error", net_error: errorMessage.match(/net::[A-Z_]+/)?.[0], http_status: Number(errorMessage.match(/response code: (\d+)/)?.[1]) || undefined }));
    await page.goto(`${origin}/w29-rejoin`);
    await page.waitForFunction(() => Boolean(window.joinClient));
    return page;
  }
  async function join(page, label) {
    const result = await page.evaluate((options) => window.joinClient(options), { label, space: space.slug, api: apiOrigin, sync: syncOrigin });
    history.push({ step: `join ${label}`, ...result, sockets: await page.evaluate(() => window.socketCounts()) });
    assert(result.ok, JSON.stringify({ history, network }));
  }
  const pageA = await pageFor(context, "A");
  await admit("admin", "admin", "owner");
  await join(pageA, "admin");
  await admit("teacher", "teacher", "owner");
  await join(pageA, "teacher");
  const original = await admit("student-A", "student");
  await join(pageA, "student-A");
  await pageA.evaluate(() => window.leaveClient("student-A"));
  await pageA.waitForFunction(() => window.socketCounts()[0] + window.socketCounts()[1] + window.socketCounts()[2] === 4);
  history.push({ step: "leave student A", durable_status: sql(`select status from participants where id='${original.participant.id}'`), sockets: await pageA.evaluate(() => window.socketCounts()) });
  assert.equal(history.at(-1).durable_status, "left");
  second = await browser.newContext();
  const pageB = await pageFor(second, "B");
  await admit("student-B", "student");
  await join(pageB, "student-B");
  await pageB.evaluate(() => window.leaveClient("student-B"));
  await pageB.waitForFunction(() => window.socketCounts()[0] + window.socketCounts()[1] + window.socketCounts()[2] === 0);
  history.push({ step: "leave student B", sockets: await pageB.evaluate(() => window.socketCounts()) });
  await pageA.evaluate(async () => { await window.leaveClient("teacher"); await window.leaveClient("admin"); });
  await pageA.waitForFunction(() => window.socketCounts()[0] + window.socketCounts()[1] + window.socketCounts()[2] === 0);
  history.push({ step: "leave remaining A", sockets: await pageA.evaluate(() => window.socketCounts()) });
  const result = { browser: browser.version(), revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), history, network, eventsA: await pageA.evaluate(() => window.socketEvents), eventsB: await pageB.evaluate(() => window.socketEvents) };
  await writeFile(resolve(output, "results.json"), JSON.stringify(result, null, 2));
  console.log("W29_REJOIN " + JSON.stringify(result));
  await pageA.evaluate(() => window.disposeClients());
  await pageB.evaluate(() => window.disposeClients());
} finally {
  await second?.close();
  await fixture.cleanup();
}
