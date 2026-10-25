import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

const fixture = await createDashboardProofFixture({ devicesMissing: true });
const { apiOrigin, origin, syncOrigin, repository, context, tenantId, bindings, cleanup } = fixture;
try {
  const page = await context.newPage();
  const frames = [];
  await context.routeWebSocket(`${syncOrigin}*`, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => server.send(message));
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
  const deadline = new Date(new Date(createdAt).getTime() + 60000).toISOString();
  const response = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/deadline`, {
    method: "POST", headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ deadline_at: deadline }),
  });
  assert.equal(response.status, 202, await response.text());
  console.log("Two participants joined; deadline:", deadline);
  await page.screenshot({ path: resolve(repository, "artifacts/time-limit-before.png") });
  await delay(Math.max(0, Date.parse(deadline) - Date.now()) + 15000);
  console.log("episode:", sql(`select status||':'||coalesce(end_reason,'') from episodes where id='${episodeId}'`));
  console.log("received:", JSON.stringify(frames.filter((frame) => JSON.stringify(frame).includes("episode_ended") || JSON.stringify(frame).includes("deadline") || frame.type === "operation_rejected")));
  await page.screenshot({ path: resolve(repository, "artifacts/time-limit-after.png") });
  const ended = await page.getByText("The call reached its time limit", { exact: true }).isVisible();
  console.log("time-limit end page:", ended, "generic end:", await page.getByText("The call ended", { exact: true }).isVisible());
  if (process.env.TIME_LIMIT_EXPECT_FIXED === "1") assert(ended, "deadline must show the usable time-limit end page");
} finally {
  await cleanup();
}
