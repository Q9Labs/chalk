import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

const fixture = await createDashboardProofFixture({ devicesMissing: true, recordingName: "time-limit-runtime.webm" });
const { apiOrigin, origin, syncOrigin, repository, context, tenantId, bindings, cleanup } = fixture;
try {
  const page = await context.newPage();
  fixture.recordPage(page);
  const frames = [];
  let rejectCommand = false;
  await context.routeWebSocket(`${syncOrigin}*`, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (rejectCommand && frame.type === "command" && frame.name === "set_hand_raised") {
        rejectCommand = false;
        socket.send(JSON.stringify({ type: "ack", command_id: frame.command_id, delivery: "original", outcome: "rejected", reason: "episode_ended" }));
      } else server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type !== "ping" && frame.type !== "pong") frames.push(frame);
      socket.send(message);
    });
  });
  await page.goto(`${origin}/dashboard`);
  await page.getByRole("button", { name: "Start a call", exact: true }).click();
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
  const spaceId = new URL(page.url()).pathname.split("/").at(-2);
  const holder = await context.newPage();
  await holder.goto(page.url());
  await holder.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
  const sql = (query) => execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-Atc", query], { encoding: "utf8" }).trim();
  const episodeId = sql(`select id from episodes where space_id='${spaceId}' and status='active'`);
  const createdAt = sql(`select created_at from episodes where id='${episodeId}'`);
  const deadline = new Date(Math.ceil(new Date(createdAt).getTime() / 1000) * 1000 + 60000).toISOString();
  if (process.env.TIME_LIMIT_EXPECT_FIXED === "1") {
    const dashboardPost = (data) =>
      page.evaluate(async (data) => {
        const session = await (await fetch("/auth/session")).json();
        const response = await fetch("/dashboard-api/call", { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify(data) });
        if (!response.ok) throw new Error(await response.text());
      }, data);
    const headers = { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() };
    const updateDeadline = async (value) => {
      const response = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/deadline`, { method: "POST", headers: { ...headers, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ deadline_at: value }) });
      assert.equal(response.status, 202, await response.text());
      for (let attempt = 0; attempt < 100 && Math.abs(Date.parse(sql(`select deadline_at from episodes where id='${episodeId}'`)) - Date.parse(value)) > 1; attempt++) await delay(100);
      assert(Math.abs(Date.parse(sql(`select deadline_at from episodes where id='${episodeId}'`)) - Date.parse(value)) <= 1);
    };
    const tenMinutes = new Date(Date.now() + 599000).toISOString();
    await updateDeadline(tenMinutes);
    await page.locator('[data-part="toast"]').filter({ hasText: "10 minutes left" }).waitFor();
    const request = page.waitForRequest((request) => request.url().endsWith("/dashboard-api/call") && request.postDataJSON()?.action === "extend-call");
    await page.getByRole("button", { name: "Add 30 min", exact: true }).click();
    const body = (await request).postDataJSON();
    for (let attempt = 0; attempt < 100 && Date.parse(sql(`select deadline_at from episodes where id='${episodeId}'`)) < Date.parse(tenMinutes) + 1800000; attempt++) await delay(100);
    const extended = sql(`select deadline_at from episodes where id='${episodeId}'`);
    assert.equal(Date.parse(extended), Date.parse(tenMinutes) + 1800000);
    await page.waitForFunction(() => !document.querySelector('[data-part="call-timer"]')?.textContent.includes("left"));
    await dashboardPost(body);
    await delay(1000);
    assert.equal(sql(`select deadline_at from episodes where id='${episodeId}'`), extended, "retry must not add another 30 minutes");
    console.log("PASS Add 30 min through dashboard server; deadline moved exactly 30 min; replay did not extend twice");
    await updateDeadline(new Date(Date.now() + 299000).toISOString());
    await page.locator('[data-part="toast"]').filter({ hasText: "5 minutes left" }).waitFor();
    console.log("PASS deadline change re-armed the warning");
    const ceiling = new Date(new Date(createdAt).getTime() + 86400000).toISOString();
    await dashboardPost({ action: "extend-call", spaceId, episodeId, deadline: new Date(Date.parse(ceiling) + 1800000).toISOString(), idempotencyKey: crypto.randomUUID() });
    for (let attempt = 0; attempt < 100 && Date.parse(sql(`select deadline_at from episodes where id='${episodeId}'`)) < Date.parse(ceiling); attempt++) await delay(100);
    assert.equal(Date.parse(sql(`select deadline_at from episodes where id='${episodeId}'`)), Date.parse(ceiling));
    await page.clock.install();
    await page.clock.setSystemTime(new Date(Date.parse(ceiling) - 599000));
    await page.locator('[data-part="toast"]').filter({ hasText: "last extension" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Add 30 min", exact: true }).count(), 0);
    await page.clock.setSystemTime(new Date());
    console.log("PASS extension clamped at the 24 h ceiling and action hidden");
    await dashboardPost({ action: "set-admission", spaceId, admission: "anyone" });
    const call = await (await context.request.get(`${origin}/dashboard-api/call?spaceId=${spaceId}`)).json();
    const guestContext = await fixture.browser.newContext();
    const guest = await guestContext.newPage();
    const invite = new URL(call.inviteUrl);
    await guest.goto(`${origin}${invite.pathname}${invite.search}${invite.hash}`);
    await guest.getByLabel("Your name").fill("Deadline Guest");
    await guest.getByRole("button", { name: "Join call", exact: true }).click();
    const guestJoined = guest.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
    const admit = page.getByRole("button", { name: "Admit Deadline Guest", exact: true });
    await Promise.race([guestJoined, admit.waitFor({ timeout: 45000 })]);
    if (await admit.isVisible()) await admit.click();
    await guestJoined;
    await updateDeadline(new Date(Date.now() + 299000).toISOString());
    await guest.locator('[data-part="toast"]').filter({ hasText: "The host can extend this call." }).waitFor();
    assert.equal(await guest.getByRole("button", { name: "Sign up free", exact: true }).count(), 0);
    fixture.deadlineGuest = guest;
    const signup = await fixture.browser.newPage();
    await signup.goto(`${origin}/dashboard/sign-in`);
    await signup.getByRole("heading", { name: "Sign in to Chalk", exact: true }).waitFor();
    await signup.getByText("New here? Signing in creates your account.", { exact: true }).waitFor();
    await signup.close();
    console.log("PASS signed-in host guest warning and real signup route");
  }
  const response = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/deadline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ deadline_at: deadline }),
  });
  assert.equal(response.status, 202, await response.text());
  console.log("Two participants joined; deadline:", deadline);
  await page.screenshot({ path: resolve(repository, "artifacts/time-limit-before.png") });
  await delay(Math.max(0, Date.parse(deadline) - Date.now()) + 15000);
  console.log("episode:", sql(`select status||':'||coalesce(end_reason,'') from episodes where id='${episodeId}'`));
  console.log("received:", JSON.stringify(frames.filter((frame) => (frame.type === "event" && (frame.name === "episode_ended" || frame.name === "deadline_changed")) || (frame.type === "welcome" && frame.mode === "terminal"))));
  await page.screenshot({ path: resolve(repository, "artifacts/time-limit-after.png") });
  const ended = await page.getByText("The call reached its time limit", { exact: true }).isVisible();
  console.log("time-limit end page:", ended, "generic end:", await page.getByText("The call ended", { exact: true }).isVisible());
  if (process.env.TIME_LIMIT_EXPECT_FIXED === "1") {
    assert(ended, "deadline must show the usable time-limit end page");
    await holder.getByRole("heading", { name: "The call reached its time limit", exact: true }).waitFor();
    await fixture.deadlineGuest.getByRole("heading", { name: "The call reached its time limit", exact: true }).waitFor();
    assert.equal(await fixture.deadlineGuest.getByRole("button", { name: "Sign up free", exact: true }).count(), 0);
    assert.equal(await fixture.deadlineGuest.getByRole("button", { name: "Start a new call", exact: true }).count(), 0);
    await page.getByRole("button", { name: "Start a new call", exact: true }).waitFor();
    await fixture.deadlineGuest.getByRole("button", { name: "Home", exact: true }).click();
    await fixture.deadlineGuest.waitForURL(`${origin}/`);
    console.log("PASS all participants reached the reason-specific end page; guest Home works");
    await page.getByRole("button", { name: "Start a new call", exact: true }).click();
    await page.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
    console.log("PASS owner Start a new call opens a usable new call");
    rejectCommand = true;
    await page.getByRole("button", { name: "Reactions", exact: true }).click();
    await page.getByRole("button", { name: "Raise hand", exact: true }).click();
    await page.getByRole("heading", { name: "The call ended", exact: true }).waitFor();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.waitForURL(`${origin}/dashboard`);
    console.log("PASS lost end event plus episode_ended command rejection leaves the browser call usable");
    const anonymousContext = await fixture.browser.newContext();
    const anonymous = await anonymousContext.newPage();
    await anonymous.goto(`${origin}/space`);
    await anonymous.getByLabel("Your name").fill("Anonymous Deadline Host");
    await anonymous.getByRole("button", { name: "Join call", exact: true }).click();
    await anonymous.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
    const anonymousGuest = await (await fixture.browser.newContext()).newPage();
    await anonymousGuest.goto(anonymous.url());
    await anonymousGuest.getByLabel("Your name").fill("Anonymous Deadline Guest");
    await anonymousGuest.getByRole("button", { name: "Join call", exact: true }).click();
    const publicGuestJoined = anonymousGuest.locator('[data-tour="video-grid"]').first().waitFor({ timeout: 45000 });
    const admitPublicGuest = anonymous.getByRole("button", { name: "Admit Anonymous Deadline Guest", exact: true });
    await Promise.race([publicGuestJoined, admitPublicGuest.waitFor({ timeout: 45000 })]);
    if (await admitPublicGuest.isVisible()) await admitPublicGuest.click();
    await publicGuestJoined;
    const slug = new URL(anonymous.url()).pathname.split("/").at(-1);
    assert.match(slug, /^[a-z0-9-]+$/);
    const [publicSpace, publicTenant, publicEpisode, publicCreated] = sql(`select s.id,s.tenant_id,e.id,e.created_at from spaces s join episodes e on e.space_id=s.id where s.slug='${slug}' and e.status='active'`).split("|");
    assert(publicEpisode, "anonymous call must have an active real Episode");
    const publicDeadline = new Date(Math.ceil(Date.parse(publicCreated) / 1000) * 1000 + 60000).toISOString();
    const publicResponse = await fetch(`${apiOrigin}/v1/tenants/${publicTenant}/spaces/${publicSpace}/episodes/${publicEpisode}/deadline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ deadline_at: publicDeadline }),
    });
    assert.equal(publicResponse.status, 202, await publicResponse.text());
    await anonymous.locator('[data-part="toast"]').filter({ hasText: "Sign up free for calls up to 24 hours." }).waitFor();
    assert.equal(await anonymous.getByRole("button", { name: "Add 30 min", exact: true }).count(), 0);
    await anonymousGuest.locator('[data-part="toast"]').filter({ hasText: "Sign up free for calls up to 24 hours." }).waitFor();
    await anonymous.getByRole("heading", { name: "The call reached its time limit", exact: true }).waitFor({ timeout: 80000 });
    await anonymous.getByRole("button", { name: "Home", exact: true }).waitFor();
    await anonymousGuest.getByRole("heading", { name: "The call reached its time limit", exact: true }).waitFor();
    await anonymousGuest.getByRole("button", { name: "Sign up free", exact: true }).click();
    await anonymousGuest.getByRole("heading", { name: "Sign in to Chalk", exact: true }).waitFor();
    await anonymous.getByRole("button", { name: "Sign up free", exact: true }).click();
    await anonymous.getByRole("heading", { name: "Sign in to Chalk", exact: true }).waitFor();
    console.log("PASS real anonymous call warning, time-limit end page and signup route");
  }
} finally {
  await cleanup();
}
