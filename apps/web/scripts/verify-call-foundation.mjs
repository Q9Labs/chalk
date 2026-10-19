import { strict as assert } from "node:assert";
import { startCallHarness } from "../src/call-states/browser-harness.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const out = process.env.FOUNDATION_ARTIFACTS;
const { origin, stop } = await startCallHarness();
let browser;
try {
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
  await page.getByRole("button", { name: "Switch to grid", exact: true }).click();
  await page.getByRole("button", { name: "Switch to spotlight", exact: true }).waitFor();
  assert.equal(await page.getByRole("menu").count(), 0, "desktop layout changes directly without a menu");
  assert.equal(await page.getByRole("button", { name: "Switch to spotlight", exact: true }).evaluate((el) => el === document.activeElement), true, "the direct toggle keeps keyboard focus");
  await page.getByRole("button", { name: "Switch to spotlight", exact: true }).click();
  await page.getByRole("button", { name: "Switch to grid", exact: true }).waitFor();
  await page.goto(`${origin}/call-states.html?state=perf-grid`);
  await page.getByRole("button", { name: "Switch to spotlight", exact: true }).click();
  await page.getByRole("button", { name: "Switch to grid", exact: true }).waitFor();
  await page.getByRole("button", { name: "Switch to grid", exact: true }).click();
  await page.getByRole("button", { name: "Switch to spotlight", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const gridStage = page.getByTestId("stage");
  await page.waitForTimeout(300);
  assert.equal(await frame.evaluate((element) => getComputedStyle(element).overflow), "clip", "the call clips at its viewport without becoming a scroll container");
  assert.equal(await gridStage.evaluate((element) => getComputedStyle(element).overflow), "visible", "the stage does not clip FLIP at its temporary fitted edge");
  const foldedTiles = gridStage.locator(':scope > div > [aria-hidden="true"]');
  assert.equal(await foldedTiles.evaluateAll((elements) => elements.every((element) => element.inert && element.getClientRects().length === 0)), true, "folded tiles stay mounted but cannot show or intercept a click");
  const overflow = page.getByRole("button", { name: /^Show \d+ more participants$/ });
  if (await overflow.isVisible()) {
    await overflow.focus();
    await page.keyboard.press("Enter");
  } else {
    await page.getByRole("button", { name: "More options", exact: true }).click();
    await page.getByRole("button", { name: "People", exact: true }).click();
  }
  const people = page.getByRole("region", { name: "People", exact: true });
  await people.waitFor();
  for (const name of ["Camera 1", "Camera 12", "Camera 23"]) {
    const person = people.getByText(name, { exact: true });
    await person.scrollIntoViewIfNeeded();
    assert.equal(await person.isVisible(), true, "People reaches the first, middle and last people without grid paging");
  }
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await page.goto(`${origin}/call-states.html?state=duo`);
  const phoneStage = page.getByTestId("stage");
  assert.equal(await page.locator('[data-part="dock-more-glyph"]').getAttribute("d"), "M5 12h.01M12 12h.01M19 12h.01");
  assert.equal(await page.locator('[data-part="dock-more-glyph"]').getAttribute("stroke-width"), "3");
  await phoneStage.locator(":scope > div > *").first().waitFor();
  await page.waitForTimeout(300);
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
  await page.waitForTimeout(300);
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
  assert.equal(await moving.evaluate((node) => node.getAnimations()[0]?.effect.getTiming().easing), "cubic-bezier(0.2, 0.8, 0.2, 1)");
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
  try {
    await browser?.close();
  } finally {
    await stop();
  }
}
