import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

// Real API, Postgres, Sync, dashboard and guest UI; only the media vendor is local.
const fixture = await createDashboardProofFixture({ devicesMissing: true });
const { apiOrigin, origin, repository, context, tenantId, bindings, cleanup } = fixture;
const directory = resolve(repository, "artifacts/word-invite-links");
let browser;
try {
  await mkdir(directory, { recursive: true });
  const owner = await context.newPage();
  fixture.recordPage(owner);
  await owner.goto(`${origin}/dashboard`);
  await owner.getByRole("button", { name: "Start a call", exact: true }).click();
  await owner.getByRole("button", { name: "Join call", exact: true }).click();
  await owner.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
  const spaceId = new URL(owner.url()).pathname.split("/").at(-2);
  const response = await context.request.get(`${origin}/dashboard-api/call?spaceId=${encodeURIComponent(spaceId)}`);
  assert.equal(response.status(), 200, await response.text());
  const { inviteUrl } = await response.json();
  const wordPath = new URL(inviteUrl).pathname;
  assert.match(wordPath, /^\/[a-z]+-[a-z]+-[a-z]+-[a-z]+$/);
  assert.equal(new URL(inviteUrl).hash, "");
  const letterCode = execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-Atqc", `select invite_code from space_public_invites where tenant_id='${tenantId}' and space_id='${spaceId}'`], { encoding: "utf8" }).trim();
  assert.match(letterCode, /^[a-z]{10}$/);
  const letterPath = `/${letterCode.slice(0, 3)}-${letterCode.slice(3, 7)}-${letterCode.slice(7)}`;
  browser = await chromium.launch({ headless: true });
  for (const [name, path] of [
    ["before-letter", letterPath],
    ["after-words", wordPath],
  ]) {
    const guestContext = await browser.newContext({ viewport: { width: 1200, height: 850 }, recordVideo: { dir: directory, size: { width: 1200, height: 850 } } });
    try {
      const guest = await guestContext.newPage();
      await guest.goto(`${origin}${path}`);
      await guest.getByLabel("Your name").fill(name);
      assert.equal(await guest.locator("html").getAttribute("data-chalk-theme"), "dark", "Both invite paths keep the default call theme");
      await guest.screenshot({ path: resolve(directory, `${name}.png`) });
      await guest.getByRole("button", { name: "Join call", exact: true }).click();
      await guest.getByText(/Asking to join/).waitFor();
      await owner.getByRole("button", { name: `Let ${name} in`, exact: true }).click();
      await guest.locator('[data-tour="video-grid"]').first().waitFor({ state: "visible", timeout: 45000 });
      await guest.screenshot({ path: resolve(directory, `${name}-joined.png`) });
      const live = await fetch(`${apiOrigin}/v1/tenants/${tenantId}/live-episodes?space_ids=${spaceId}`, { headers: { Authorization: `Bearer ${bindings.DASHBOARD_SERVICE_TOKEN}` } });
      assert.equal(live.status, 200);
      const participants = (await live.json()).spaces[0].live_episode.participants;
      assert(participants.length >= 2, "Owner and guest have real live seats");
      await guestContext.close();
      await guest.video()?.saveAs(resolve(directory, `${name}.webm`));
    } finally {
      await guestContext.close();
    }
  }
  await writeFile(resolve(directory, "length.json"), JSON.stringify({ before: `https://chalkmeet.com${letterPath}`.length, after: `https://chalkmeet.com${wordPath}`.length, beforePath: letterPath, afterPath: wordPath }, null, 2));
  console.log("PASS: letter and four-word URLs enter a real call through API, Postgres and Sync");
} finally {
  await browser?.close();
  await cleanup();
}
