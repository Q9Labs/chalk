import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const port = process.env.CHALK_CALL_INTEGRATION_PORT || "3098";
const origin = `http://127.0.0.1:${port}`;
const out = process.env.CALL_INTEGRATION_ARTIFACTS;
if (
  await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  )
)
  throw new Error(`Integration port is occupied: ${origin}`);
const server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", port, "--strictPort"], { cwd: resolve(import.meta.dirname, ".."), detached: true, stdio: "ignore" });
const watchdog = spawn(
  process.execPath,
  [
    "-e",
    `
  const owner = Number(process.argv[1]);
  const server = Number(process.argv[2]);
  const deadline = Date.now() + 120_000;
  setInterval(() => {
    let alive = true;
    try { process.kill(owner, 0); } catch { alive = false; }
    if (alive && Date.now() < deadline) return;
    try { process.kill(-server, "SIGTERM"); } catch {}
    process.exit();
  }, 1000);
`,
    String(process.pid),
    String(server.pid),
  ],
  { detached: true, stdio: "ignore" },
);
watchdog.unref();
let browser;
try {
  const deadline = Date.now() + 30_000;
  while (
    !(await fetch(`${origin}/call-states.html`).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    if (server.exitCode !== null || Date.now() > deadline) throw new Error("Integration harness did not start");
    await new Promise((done) => setTimeout(done, 200));
  }
  if (out) await mkdir(out, { recursive: true });
  browser = await chromium.launch({ headless: true });
  for (const [device, viewport] of Object.entries({ laptop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
    const context = await browser.newContext({ viewport });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/call-states.html?state=integration-call`);
      const stage = page.getByTestId("stage");
      await stage.waitFor();
      await page.evaluate(() => document.fonts.ready);
      const detailsTrigger = page.getByRole("button", { name: "Call details", exact: true });
      await detailsTrigger.click();
      const details = page.getByRole("dialog", { name: "Call details", exact: true });
      await details.getByText("example.com/invite/test-call", { exact: true }).waitFor();
      await details.getByRole("img", { name: "Scan to join this call", exact: true }).waitFor();
      await details.getByRole("button", { name: "Close", exact: true }).click();
      await details.waitFor({ state: "hidden" });
      const linkTrigger = device === "phone" ? page.getByRole("button", { name: "Call details", exact: true }) : page.getByRole("button", { name: "Show call link", exact: true });
      if (device === "phone") {
        await linkTrigger.click();
        await page.getByRole("dialog", { name: "Call details", exact: true }).getByRole("button", { name: "Show call link", exact: true }).click();
      } else await linkTrigger.click();
      const readyTitle = page.getByRole("region", { name: "Your call is ready", exact: true }).getByRole("heading", { name: "Your call is ready", exact: true });
      await readyTitle.waitFor();
      assert.equal(await page.locator('[data-part="ready-link"]').innerText(), "example.com/invite/test-call");
      await page.getByRole("button", { name: "Close call link", exact: true }).click();
      await readyTitle.waitFor({ state: "hidden" });
      const returned = device === "phone" ? linkTrigger : page.getByRole("button", { name: "Show call link", exact: true });
      assert.equal(await returned.evaluate((element) => element === document.activeElement), true, `${device}: closing the call link returns focus`);
      await page.mouse.move(40, 100);
      await page.waitForTimeout(250);
      if (out) await page.screenshot({ path: resolve(out, `${device}-before.png`) });
      const initialWidth = (await stage.boundingBox()).width;
      const video = await stage.locator("video").first().elementHandle();
      assert.ok(video, "the integrated stage renders a live video element");
      if (device === "phone") {
        await page.getByRole("button", { name: "More options", exact: true }).click();
        await page.getByRole("dialog", { name: "More options", exact: true }).getByRole("button", { name: "People", exact: true }).click();
      } else await page.getByRole("button", { name: /^People, \d+$/ }).click();
      const people = page.getByRole("tab", { name: /^People/ });
      await people.waitFor();
      assert.equal(await people.getAttribute("aria-selected"), "true", "the shell opens the People tab");
      await page.waitForTimeout(300);
      if (device === "laptop") assert.ok((await stage.boundingBox()).width < initialWidth, "the stage refits beside the side card");
      assert.equal(await video.evaluate((element) => element.isConnected), true, "card refits preserve the video element");
      if (out) await page.screenshot({ path: resolve(out, `${device}-after.png`) });
      await page.getByRole("tab", { name: "Chat", exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-card-tab="chat"]')?.getAttribute("aria-selected") === "true");
      await page.getByRole("button", { name: "Close panel", exact: true }).click();
      await people.waitFor({ state: "hidden" });
      await page.getByRole("button", { name: "Turn on camera", exact: true }).click();
      await page.getByText("Chalk can’t use your camera.", { exact: true }).waitFor();
      await page.getByRole("button", { name: "Unmute microphone", exact: true }).click();
      await page.getByText("Chalk can’t use your microphone.", { exact: true }).waitFor();
      await page.goto(`${origin}/call-states.html?state=integration-terminal`);
      await page.getByRole("button", { name: "Report a problem", exact: true }).click();
      await page.getByRole("textbox", { name: "What went wrong?", exact: true }).fill("The call disconnected.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByRole("heading", { name: "Sent", exact: true }).waitFor();
      assert.equal(await page.getByLabel("Submitted problem", { exact: true }).innerText(), "The call disconnected.");
      await page.getByRole("button", { name: "Done", exact: true }).click();
      await page.getByRole("heading", { name: "Sent", exact: true }).waitFor({ state: "hidden" });
      assert.equal(await page.getByRole("button", { name: "Report a problem", exact: true }).evaluate((element) => element === document.activeElement), true, "the report dialog returns terminal focus");
      assert.deepEqual(errors, [], `${device}: no runtime errors`);
      console.log(`${device}: call-link sharing/focus, People/Chat card, stage continuity and typed media failures passed`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  watchdog.kill();
}
