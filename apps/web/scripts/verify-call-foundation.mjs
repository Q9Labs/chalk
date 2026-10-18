import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const web = resolve(import.meta.dirname, "..");
const origin = "http://127.0.0.1:3097";
const out = process.env.FOUNDATION_ARTIFACTS;
const occupied = await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(
  () => true,
  () => false,
);
if (occupied) throw new Error(`Foundation harness port is already in use: ${origin}`);
const server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", "3097", "--strictPort"], { cwd: web, detached: true, stdio: "ignore" });
const deadline = setTimeout(() => {
  process.kill(-server.pid, "SIGTERM");
  process.exitCode = 124;
}, 100_000);
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Harness exited ${server.exitCode}`);
    try {
      if ((await fetch(`${origin}/call-states.html`)).ok) break;
    } catch {}
    await new Promise((done) => setTimeout(done, 200));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/call-states.html?state=duo`);
  const frame = page.locator('[data-part="call-frame"]');
  await frame.waitFor();
  assert.equal(await frame.getAttribute("data-chalk-theme"), "dark", "call defaults to dark, independently of the OS");
  await page.getByRole("button", { name: "Call details", exact: true }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  assert.equal(await frame.getAttribute("data-chalk-theme"), "light");
  await page.reload();
  await frame.waitFor();
  assert.equal(await frame.getAttribute("data-chalk-theme"), "light", "Light survives a reload");
  await page.getByRole("button", { name: "Layout: Spotlight", exact: true }).click();
  const items = page.getByRole("menuitemradio");
  await items.first().waitFor();
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.getByRole("menu").evaluate((el) => el.contains(document.activeElement)), true, "arrow key moves focus into the menu");
  await page.keyboard.press("End");
  assert.equal(await items.last().evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "detached" });
  assert.equal(await page.getByRole("menu").count(), 0);
  assert.equal(await page.getByRole("button", { name: "Layout: Spotlight", exact: true }).evaluate((el) => el === document.activeElement), true, "Escape restores the trigger");
  await page.goto(`${origin}/call-states.html?state=perf-grid`);
  await page.getByRole("button", { name: "Layout: Grid", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Spotlight", exact: true }).click();
  await page.getByRole("button", { name: "Layout: Spotlight", exact: true }).waitFor();
  await page.getByRole("button", { name: "Layout: Spotlight", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Grid", exact: true }).click();
  await page.getByRole("button", { name: "Layout: Grid", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/call-states.html?state=duo`);
  const phoneStage = page.getByTestId("stage");
  await phoneStage.locator(":scope > div > *").first().waitFor();
  const tilesBefore = await phoneStage.locator(":scope > div > *").elementHandles();
  const spotlightBox = await tilesBefore[0].boundingBox();
  await page.getByRole("button", { name: "More options", exact: true }).click();
  const more = page.getByRole("dialog", { name: "More options", exact: true });
  await more.getByRole("button", { name: "Grid", exact: true }).click();
  assert.equal(await more.getByRole("button", { name: "Grid", exact: true }).getAttribute("aria-pressed"), "true");
  await page.waitForTimeout(300);
  assert.notDeepEqual(await tilesBefore[0].boundingBox(), spotlightBox, "dock selection re-fits the actual stage");
  await more.getByRole("button", { name: "Spotlight", exact: true }).click();
  await page.waitForTimeout(300);
  const tilesAfter = phoneStage.locator(":scope > div > *");
  assert.equal(await tilesAfter.first().evaluate((node, original) => node === original, tilesBefore[0]), true, "dock layout changes retain mounted tiles");
  await page.keyboard.press("Escape");
  await more.waitFor({ state: "detached" });
  await page.goto(`${origin}/web-space-journey.html`);
  await page.getByRole("button", { name: "More options", exact: true }).click();
  const webMore = page.getByRole("dialog", { name: "More options", exact: true });
  const webStage = page.getByTestId("stage");
  const webTiles = await webStage.locator(":scope > div > *").elementHandles();
  const webSpotlight = await webTiles[0].boundingBox();
  await webMore.getByRole("button", { name: "Grid", exact: true }).click();
  await page.waitForTimeout(300);
  assert.notDeepEqual(await webTiles[0].boundingBox(), webSpotlight, "SpacePage → LocalSpace → Chalk switches to Grid from the dock");
  await webMore.getByRole("button", { name: "Spotlight", exact: true }).click();
  await page.waitForTimeout(300);
  assert.equal(
    await webStage
      .locator(":scope > div > *")
      .first()
      .evaluate((node, original) => node === original, webTiles[0]),
    true,
    "the web product path retains its tile",
  );
  assert.deepEqual(await webTiles[0].boundingBox(), webSpotlight, "the web product path switches back to Spotlight");
  await page.keyboard.press("Escape");
  await webMore.waitFor({ state: "detached" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/call-states.html?state=foundation-toast`);
  const toast = page.getByRole("status").filter({ hasText: "Nora joined" });
  await toast.waitFor();
  assert.equal(await toast.getAttribute("aria-live"), "polite");
  if (out) {
    await mkdir(out, { recursive: true });
    for (const [device, viewport] of Object.entries({ laptop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } })) {
      await page.setViewportSize(viewport);
      for (const theme of ["dark", "light"]) {
        await context.addCookies([{ name: "chalk_theme", value: theme, url: origin }]);
        await page.goto(`${origin}/call-states.html?state=duo`);
        await frame.waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: resolve(out, `${device}-${theme}.png`) });
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${origin}/call-states.html?state=duo`);
  await page.getByRole("button", { name: "Call details", exact: true }).click();
  const sheet = page.getByRole("dialog", { name: "Call details" });
  await sheet.waitFor();
  await sheet.evaluate(async (element) => Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const sheetBox = await sheet.boundingBox();
  assert.ok(sheetBox && Math.abs(sheetBox.x) < 1 && Math.abs(sheetBox.width - 390) < 1 && Math.abs(sheetBox.y + sheetBox.height - 876) < 1, "phone details anchors to the call viewport with the mockup's 32px translation, not its header trigger");
  const scrimBox = await page.locator('[data-part="sheet-scrim"]').boundingBox();
  assert.deepEqual(scrimBox, { x: 0, y: 0, width: 390, height: 844 }, "sheet scrim covers the call viewport");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("Tab");
    await page.waitForFunction(() => document.querySelector('[data-part="sheet"]')?.contains(document.activeElement));
    assert.equal(await sheet.evaluate((el) => el.contains(document.activeElement)), true, "phone sheet traps focus");
  }
  await page.keyboard.press("Escape");
  await sheet.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("button", { name: "Call details", exact: true }).evaluate((el) => el === document.activeElement), true);
  await page.waitForTimeout(3300);
  assert.notEqual(await frame.getAttribute("data-idle"), "true", "phone chrome never fades for an idle pointer");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${origin}/call-states.html?state=foundation-kit-dark`);
  const moving = page.locator('[data-part="flip-fixture"]');
  const identity = await moving.elementHandle();
  await page.getByRole("button", { name: "Move fixture", exact: true }).click();
  assert.equal(await moving.evaluate((node, original) => node === original, identity), true, "FLIP preserves the mounted node");
  assert.equal(await moving.evaluate((node) => node.getAnimations()[0]?.effect.getTiming().duration), 220);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Move fixture", exact: true }).click();
  assert.equal(await moving.evaluate((node) => node.getAnimations().filter((animation) => animation.playState === "running").length), 0, "reduced motion is instant");
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "https://chalkmeet.com/q9-team");
  assert.deepEqual(errors, [], "no browser errors");
  console.log("PASS: default Dark, persistent Light, arrow keys and Esc, announced toast, phone focus trap");
  if (out) await writeFile(resolve(out, "journeys.json"), JSON.stringify({ passed: true, errors }, null, 2));
  await context.close();
} finally {
  clearTimeout(deadline);
  await browser?.close();
  try {
    process.kill(-server.pid, "SIGTERM");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  if (server.exitCode === null)
    await new Promise((done) => {
      server.once("exit", done);
      setTimeout(done, 2000).unref();
    });
}
