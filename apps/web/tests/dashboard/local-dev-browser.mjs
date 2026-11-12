import { strict as assert } from "node:assert";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

// Run on the Orb, against its public origin, never a fixture HTTP server.
const origin = new URL(process.argv[2]).origin;
const output = resolve(process.argv[3] || ".verify/dashboard-local-dev");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const results = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const unauthenticated = await context.request.get(`${origin}/auth/session`);
  assert.equal(unauthenticated.status(), 401);
  await page.goto(`${origin}/dashboard`);
  await page.getByRole("button", { name: "Continue with Google" }).waitFor();
  await page.screenshot({ path: resolve(output, "signed-out.png"), fullPage: true });
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("link", { name: "Ada", exact: true }).click();
  await page.getByRole("heading", { name: "Recent calls" }).waitFor({ timeout: 60000 });
  const session = await (await context.request.get(`${origin}/auth/session`)).json();
  assert.equal(session.profile.name, "Ada Fixture");
  async function get(path) {
    const response = await context.request.get(`${origin}${path}`);
    assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
    return response.json();
  }
  async function visit(path, heading, name) {
    await page.goto(`${origin}${path}`);
    await page.locator("h1").filter({ hasText: heading }).waitFor({ timeout: 60000 });
    const content = heading === "Developer" ? "Local development" : heading === "Product planning" ? "Past sessions" : "Product planning";
    await page.getByText(content, { exact: true }).first().waitFor({ timeout: 60000 });
    assert(!(await page.locator("body").innerText()).includes("Couldn't open"));
    await page.screenshot({ path: resolve(output, `${name}.png`), fullPage: true });
    results.push(name);
  }
  const home = await get("/dashboard-api/home");
  assert.equal(home.calls.length, 3);
  await visit("/dashboard", "Recent calls", "home");
  const product = home.calls.find((call) => call.name === "Product planning");
  assert(product);
  const call = await get(`/dashboard-api/call?spaceId=${product.id}`);
  assert.equal(call.episodes.length, 1);
  await visit(`/dashboard/call/${product.id}`, "Product planning", "call");
  const episode = call.episodes[0];
  const past = await get(`/dashboard-api/past-session?spaceId=${product.id}&episodeId=${episode.id}`);
  assert.equal(past.attendance.participants.length, 3);
  assert.equal(past.recordings[0].status, "completed");
  assert.equal(past.recordings[0].transcripts[0].status, "complete");
  await page.goto(`${origin}/dashboard/call/${product.id}/session/${episode.id}`);
  await page.getByRole("heading", { name: "Who joined" }).waitFor({ timeout: 60000 });
  await page.getByText("Let's walk through the new onboarding flow and agree on the next steps.", { exact: true }).waitFor({ timeout: 60000 });
  await page.locator("video").evaluate(async (video) => {
    await video.play();
  });
  await page.waitForFunction(() => document.querySelector("video")?.currentTime > 0);
  await page.screenshot({ path: resolve(output, "session.png"), fullPage: true });
  results.push("session-transcript-and-playback");
  const developer = await get("/dashboard-api/developer");
  assert(developer.keys.some((key) => key.name === "Local development"));
  await visit("/dashboard/developer", "Developer", "developer");
  await get("/dashboard-api/sessions");
  await visit("/dashboard/sessions", "Sessions", "sessions");
  await get("/dashboard-api/recordings");
  await visit("/dashboard/recordings", "Recordings", "recordings");
  for (const name of ["Design review", "Weekly catch-up"]) {
    const item = home.calls.find((entry) => entry.name === name);
    const detail = await get(`/dashboard-api/call?spaceId=${item.id}`);
    const history = await get(`/dashboard-api/past-session?spaceId=${item.id}&episodeId=${detail.episodes[0].id}`);
    assert.equal(history.recordings.length, name === "Design review" ? 0 : 1);
    if (name === "Weekly catch-up") assert.equal(history.recordings[0].status, "failed");
  }
  await context.close();
  const empty = await browser.newContext();
  const emptyPage = await empty.newPage();
  await emptyPage.goto(`${origin}/dashboard/sign-in`);
  await emptyPage.getByRole("button", { name: "Continue with Apple" }).click();
  await emptyPage.getByRole("link", { name: "Malik", exact: true }).click();
  await emptyPage.getByRole("heading", { name: "Recent calls" }).waitFor({ timeout: 60000 });
  const emptyHome = await (await empty.request.get(`${origin}/dashboard-api/home`)).json();
  assert.equal(emptyHome.calls.length, 0);
  await emptyPage.screenshot({ path: resolve(output, "empty-owner.png"), fullPage: true });
  results.push("apple-sign-in-and-empty-owner");
  await empty.close();
  await writeFile(resolve(output, "result.json"), JSON.stringify({ origin, results }, null, 2));
  console.log(`PASS: ${results.join(", ")}; evidence ${output}`);
} catch (error) {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {});
      console.error((await page.locator("body").innerText()).slice(0, 1400));
    }
  throw error;
} finally {
  await browser.close();
}
