import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

// An unacknowledged Leave keeps the owner's join key. If the Leave never
// committed, the next mount reattaches that seat; if it did commit, the seat
// refuses the key and the next mount must join with a fresh one.
const fixture = await createDashboardProofFixture({ recordingName: "owner-leave-unconfirmed.webm", devicesMissing: true });
const { apiOrigin, origin, syncOrigin, repository, context, tenantId, userId, bindings, cleanup } = fixture;
const page = await context.newPage();
fixture.recordPage(page);
try {
  let mode = "pass";
  let silenced = false;
  const interceptedLeaves = [];
  let releaseLeave;
  let heldLeaveSeen;
  const heldLeave = new Promise((resolve) => {
    heldLeaveSeen = resolve;
  });
  const entries = new Map();
  const observeEntry = async (tab, interceptLeave = false) => {
    entries.set(tab, 0);
    await tab.routeWebSocket(`${syncOrigin}*`, (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const frame = JSON.parse(String(message));
        if (interceptLeave && frame.type === "operation" && frame.name === "participant_leave") {
          interceptedLeaves.push(mode);
          if (mode === "slow-leave") {
            releaseLeave = () => server.send(message);
            heldLeaveSeen();
            return;
          }
          if (mode === "drop-leave") return;
          // The Leave reaches Sync, then the connection goes quiet before any reply.
          if (mode === "drop-leave-ack") silenced = true;
        }
        server.send(message);
      });
      server.onMessage((message) => {
        if (interceptLeave && silenced) return;
        if (JSON.parse(String(message)).type === "entered_ack") entries.set(tab, entries.get(tab) + 1);
        socket.send(message);
      });
    });
  };
  await observeEntry(page, true);
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
  const waitForSeats = async (expected, label) => {
    let seats;
    for (let attempt = 0; attempt < 450; attempt++) {
      seats = (await live()).sort();
      if (JSON.stringify(seats) === JSON.stringify([...expected].sort())) break;
      await delay(100);
    }
    assert.deepEqual(seats, [...expected].sort(), `${label}: exact authoritative live seats`);
    console.log(`PASS ${label}: exact live seats ${JSON.stringify(seats)}`);
  };
  const waitForEntry = async (tab, previous, expected, label) => {
    for (let attempt = 0; attempt < 450 && entries.get(tab) <= previous; attempt++) await delay(100);
    assert(entries.get(tab) > previous, `${label}: Sync must acknowledge completed entry`);
    await waitForSeats(expected, label);
  };
  const first = admissions.at(-1);
  assert.equal(first?.status, 200);
  await waitForEntry(page, 0, [first.participantId], "first owner entry");
  // A second owner tab keeps the Episode live, so the next mount keeps the stored key.
  const holder = await context.newPage();
  await observeEntry(holder);
  const holderAdmission = holder.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().postDataJSON()?.action === "join");
  await holder.goto(joinUrl);
  const holderResponse = await holderAdmission;
  assert.equal(holderResponse.status(), 200);
  const holderId = (await holderResponse.json()).access.subject.participant_id;
  assert.notEqual(holderId, first.participantId, "the holder tab must own a distinct seat");
  await holder.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
  console.log("holder seats at grid visibility:", JSON.stringify(await live()));
  await waitForEntry(holder, 0, [first.participantId, holderId], "holder entry");
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
    await waitForSeats(nextMode === "drop-leave" ? [first.participantId, holderId] : [holderId], `${nextMode} before rejoin`);
    console.log(`PASS ${nextMode}: intercepted one Leave through the ${opensMenu ? "menu" : "direct button"}; committed=${nextMode === "drop-leave-ack"}`);
    mode = "pass";
    silenced = false;
    await page.goto(`${origin}/dashboard`);
    await page.goto(joinUrl);
  };

  const firstEntries = entries.get(page);
  await leaveUnconfirmed("drop-leave");
  await grid();
  await waitForEntry(page, firstEntries, [first.participantId, holderId], "uncommitted Leave reentry");
  const reattached = admissions.at(-1);
  assert.deepEqual({ status: reattached.status, key: reattached.key, participantId: reattached.participantId }, { status: 200, key: first.key, participantId: first.participantId }, "an uncommitted Leave must reattach the same seat with the retained key");
  assert.equal((await live()).filter((id) => id === first.participantId).length, 1);
  console.log("PASS uncommitted Leave: the next mount reattached the same seat");

  const before = admissions.length;
  const reattachedEntries = entries.get(page);
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
  console.log("fresh seats at grid visibility:", JSON.stringify(await live()));
  await waitForEntry(page, reattachedEntries, [fresh, holderId], "committed Leave reentry");
  console.log("PASS committed Leave with a lost acknowledgement: the next mount joined with a fresh key");

  const mounting = await context.newPage();
  await observeEntry(mounting);
  await mounting.goto(`${origin}/dashboard`);
  const intentStorageName = `chalk.owner-join:${userId}:${spaceId}`;
  const stored = await page.evaluate((name) => [sessionStorage.getItem(name), sessionStorage.getItem(`${name}:episode`)], intentStorageName);
  assert(
    stored.every((value) => value !== null),
    "the unresolved join intent and Episode must be stored",
  );
  await mounting.evaluate(
    ({ intentStorageName, stored }) => {
      sessionStorage.setItem(intentStorageName, stored[0]);
      sessionStorage.setItem(`${intentStorageName}:episode`, stored[1]);
    },
    { intentStorageName, stored },
  );
  mode = "slow-leave";
  const leave = page.getByRole("button", { name: "Leave call", exact: true });
  const opensMenu = (await leave.getAttribute("aria-haspopup")) === "menu";
  await leave.click();
  if (opensMenu) await page.getByRole("menuitem", { name: "Leave call", exact: true }).click();
  await Promise.race([
    heldLeave,
    delay(30000).then(() => {
      throw Error("slow Leave was not intercepted");
    }),
  ]);
  const mountAdmission = mounting.waitForResponse((response) => response.url() === `${origin}/dashboard-api/call` && response.request().postDataJSON()?.action === "join");
  await mounting.goto(joinUrl);
  const mounted = await mountAdmission;
  assert.equal(mounted.status(), 200);
  assert.equal((await mounted.json()).access.subject.participant_id, fresh, "fresh mount must retain the unresolved seat");
  await waitForEntry(mounting, 0, [fresh, holderId], "fresh mount before slow Leave release");
  releaseLeave();
  await delay(2500);
  await waitForSeats([fresh, holderId], "fresh mount after slow Leave release");
  await mounting.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 1000 });
  console.log("PASS fresh mount racing a slow Leave: same seat retained, no duplicate or ghost");
  await page.screenshot({ path: resolve(repository, "artifacts/owner-leave-unconfirmed.png") });
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
