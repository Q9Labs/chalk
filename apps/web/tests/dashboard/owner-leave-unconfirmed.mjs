import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

// An unacknowledged Leave keeps the owner's join key. If the Leave never
// committed, the next mount reattaches that seat; if it did commit, the seat
// refuses the key and the next mount must join with a fresh one.
const fixture = await createDashboardProofFixture({ recordingName: "owner-leave-unconfirmed.webm", devicesMissing: true });
const { apiOrigin, origin, syncOrigin, repository, context, tenantId, bindings, cleanup } = fixture;
const page = await context.newPage();
fixture.recordPage(page);
try {
  let mode = "pass";
  let silenced = false;
  const interceptedLeaves = [];
  await page.routeWebSocket(`${syncOrigin}*`, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "operation" && frame.name === "participant_leave") {
        interceptedLeaves.push(mode);
        if (mode === "drop-leave") return;
        // The Leave reaches Sync, then the connection goes quiet before any reply.
        if (mode === "drop-leave-ack") silenced = true;
      }
      server.send(message);
    });
    server.onMessage((message) => {
      if (!silenced) socket.send(message);
    });
  });
  // With the connection gone, the cleanup request after the unanswered Leave is lost too.
  await page.route("**/cancel-join", (route) => (mode === "drop-leave-ack" ? route.abort() : route.continue()));
  const admissions = [];
  page.on("response", async (response) => {
    if (response.url() === `${origin}/dashboard-api/call` && response.request().method() === "POST" && response.request().postDataJSON()?.action === "join") {
      admissions.push({ status: response.status(), key: response.request().postDataJSON().idempotencyKey, participantId: response.ok() ? (await response.json()).access.subject.participant_id : null });
    }
  });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole("button", { name: "Start a call", exact: true }).click();
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  const grid = () => page.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
  await grid();
  const joinUrl = page.url();
  const spaceId = new URL(joinUrl).pathname.split("/").at(-2);
  const live = async () => {
    const response = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/live-episodes?space_ids=${spaceId}`, { headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}` } });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).spaces[0]?.live_episode?.participants.map((participant) => participant.participant_id) ?? [];
  };
  // A second owner tab keeps the Episode live, so the next mount keeps the stored key.
  const holder = await context.newPage();
  await holder.goto(joinUrl);
  await holder.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
  const first = admissions.at(-1);
  assert.equal(first?.status, 200);
  const leaveUnconfirmed = async (nextMode) => {
    mode = nextMode;
    const leavesBefore = interceptedLeaves.length;
    const cleanupAttempt = page.waitForRequest((request) => request.url().endsWith("/cancel-join"), { timeout: 30000 });
    const leave = page.getByRole("button", { name: "Leave call", exact: true });
    const opensMenu = (await leave.getAttribute("aria-haspopup")) === "menu";
    await leave.click();
    if (opensMenu) await page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
    await cleanupAttempt;
    assert.deepEqual(interceptedLeaves.slice(leavesBefore), [nextMode], "the intended Leave operation must be intercepted exactly once");
    await delay(500);
    if (nextMode === "drop-leave-ack") {
      for (let attempt = 0; attempt < 100 && (await live()).includes(first.participantId); attempt++) await delay(100);
    }
    assert.equal((await live()).includes(first.participantId), nextMode === "drop-leave", "the seat must reflect whether Leave committed before rejoining");
    console.log(`PASS ${nextMode}: intercepted one Leave through the ${opensMenu ? "menu" : "direct button"}; committed=${nextMode === "drop-leave-ack"}`);
    mode = "pass";
    silenced = false;
    await page.goto(`${origin}/dashboard`);
    await page.goto(joinUrl);
  };

  await leaveUnconfirmed("drop-leave");
  await grid();
  const reattached = admissions.at(-1);
  assert.deepEqual({ status: reattached.status, key: reattached.key, participantId: reattached.participantId }, { status: 200, key: first.key, participantId: first.participantId }, "an uncommitted Leave must reattach the same seat with the retained key");
  assert.equal((await live()).filter((id) => id === first.participantId).length, 1);
  console.log("PASS uncommitted Leave: the next mount reattached the same seat");

  const before = admissions.length;
  await leaveUnconfirmed("drop-leave-ack");
  for (let attempt = 0; attempt < 200 && !admissions.slice(before).some((admission) => admission.status === 200); attempt++) await delay(100);
  const replay = admissions.slice(before);
  assert.deepEqual(
    replay.map(({ status, key }) => ({ status, retained: key === first.key })),
    [
      { status: 409, retained: true },
      { status: 200, retained: false },
    ],
    "a committed Leave must refuse the retained key once, then join with a fresh key",
  );
  await grid();
  const fresh = replay[1].participantId;
  assert.notEqual(fresh, first.participantId);
  const seats = await live();
  assert(seats.includes(fresh) && !seats.includes(first.participantId), "the fresh seat is live and the left seat stays left");
  await page.screenshot({ path: resolve(repository, "artifacts/owner-leave-unconfirmed.png") });
  console.log("PASS committed Leave with a lost acknowledgement: the next mount joined with a fresh key");
} catch (error) {
  await page.screenshot({ path: resolve(repository, "artifacts/owner-leave-unconfirmed-failure.png") }).catch(() => undefined);
  console.error(
    "page text at failure:",
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  );
  console.error(
    "dashboard engine failures:",
    fixture.pagesLog
      .join("")
      .split("\n")
      .filter((line) => line.includes("dashboard.engine_failed"))
      .join("\n"),
  );
  throw error;
} finally {
  await cleanup();
}
