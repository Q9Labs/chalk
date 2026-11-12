import { strict as assert } from "node:assert";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createDashboardProofFixture } from "./browser-fixture.mjs";

// Drives the real dashboard against the real API. With LANGUAGE_SHOTS_DIR set, it also saves a screenshot of every picker state in both themes and both sizes.
const fixture = await createDashboardProofFixture();
const { context, origin, repository, cleanup } = fixture;
const shotsDir = process.env.LANGUAGE_SHOTS_DIR ? resolve(process.env.LANGUAGE_SHOTS_DIR) : null;
await mkdir(resolve(repository, "artifacts/transcript-language"), { recursive: true });
if (shotsDir) await mkdir(shotsDir, { recursive: true });
const page = await context.newPage();
const sizes = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };
let size = "desktop";
let theme = "dark";

const trigger = (name) => page.getByRole("button", { name: new RegExp(`^${name}`) });
const search = () => page.getByRole("combobox", { name: "Search languages", exact: true });
const readyDialog = () => page.getByRole("dialog").filter({ hasText: "Your call is ready" });
// Starting a call and choosing its language in the ready dialog both post to the home endpoint; the action tells them apart.
const homeAction = (action) => page.waitForResponse((response) => response.url().endsWith("/dashboard-api/home") && response.request().method() === "POST" && response.status() === 200 && response.request().postDataJSON()?.action === action);

async function setLook(nextTheme, nextSize) {
  theme = nextTheme;
  size = nextSize;
  await context.addCookies([{ name: "chalk_theme", value: theme, url: origin }]);
  await page.setViewportSize(sizes[size]);
}

// A phone sheet covers the screen; otherwise the shot is the section plus any open list, so the picture holds the control and its list.
async function shot(name, area) {
  if (!shotsDir) return;
  // Let the list and sheet finish sliding in, or the page shows through them.
  await page.waitForTimeout(500);
  const path = resolve(shotsDir, `${theme}-${size}-${name}.png`);
  if (await page.locator(".scrim .lp-pop").count()) return page.screenshot({ path });
  const boxes = [];
  for (const locator of [area, page.locator(".lp-pop")]) {
    if (await locator.count()) boxes.push(await locator.first().boundingBox());
  }
  const scroll = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
  const left = Math.max(0, Math.min(...boxes.map((box) => box.x)) + scroll.x - 16);
  const top = Math.max(0, Math.min(...boxes.map((box) => box.y)) + scroll.y - 16);
  const right = Math.max(...boxes.map((box) => box.x + box.width)) + scroll.x + 16;
  const bottom = Math.max(...boxes.map((box) => box.y + box.height)) + scroll.y + 16;
  await page.screenshot({ path, fullPage: true, clip: { x: left, y: top, width: Math.min(right, sizes[size].width) - left, height: bottom - top } });
}

async function pickByTyping(text) {
  await search().fill(text);
  await search().press("Enter");
}

// The control is slow on purpose for one request, so its busy and disabled looks can be seen.
async function slowly(urlPart, method, work) {
  let release = () => {};
  const held = new Promise((done) => (release = done));
  await page.route(`**/${urlPart}`, async (route) => {
    if (route.request().method() === method) await held;
    // The page may have moved on while the request was held.
    await route.continue().catch(() => {});
  });
  try {
    await work();
  } finally {
    release();
    await page.unroute(`**/${urlPart}`);
  }
}

async function closeReadyDialog() {
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
}

try {
  // Behavior first: the account language, one call's language, and a new call started in a chosen language.
  await setLook("dark", "desktop");
  await page.goto(`${origin}/dashboard/developer`);
  const account = page.getByRole("region", { name: "Calls", exact: true });
  await trigger("Transcript language").waitFor();
  assert.match(await trigger("Transcript language").innerText(), /Auto-detect/);
  await trigger("Transcript language").click();
  assert.equal(await page.getByRole("option", { name: /Use account default/ }).count(), 0);
  await pickByTyping("urdu");
  await page.getByText("Transcript language saved", { exact: true }).waitFor();
  await page.reload();
  await trigger("Transcript language").waitFor();
  assert.match(await trigger("Transcript language").innerText(), /Urdu/);

  // Home starts a call in the remembered language; the ready dialog changes it, and the next call starts with that choice.
  await page.goto(`${origin}/dashboard`);
  const defaultCall = homeAction("create-call");
  await page.getByRole("button", { name: "Start a call", exact: true }).first().click();
  const inherited = (await (await defaultCall).json()).call;
  assert.equal(inherited.transcriptLanguage, null, "a call started on the account default inherits");
  await readyDialog().waitFor();
  assert.match(await trigger("Transcript language").innerText(), /Use account default/);
  await trigger("Transcript language").click();
  const chosen = homeAction("set-transcript-language");
  await pickByTyping("arabic");
  assert.equal((await (await chosen).json()).call.transcriptLanguage, "ar", "the ready dialog saves the call's language");
  assert.match(await trigger("Transcript language").innerText(), /Arabic/);
  await closeReadyDialog();

  await page.reload();
  const arabicCall = homeAction("create-call");
  await page.getByRole("button", { name: "Start a call", exact: true }).first().click();
  const made = (await (await arabicCall).json()).call;
  assert.equal(made.transcriptLanguage, "ar", "the next call starts with the last choice, even after a reload");
  await closeReadyDialog();

  await page.goto(`${origin}/dashboard/call/${made.id}`);
  await trigger("Transcript language").waitFor();
  assert.match(await trigger("Transcript language").innerText(), /Arabic/);
  await trigger("Transcript language").click();
  const saved = page.waitForResponse((response) => response.url().endsWith("/dashboard-api/call") && response.request().method() === "POST" && response.status() === 200);
  await page.getByRole("option", { name: /Use account default/ }).click();
  await saved;
  await page.reload();
  await trigger("Transcript language").waitFor();
  assert.match(await trigger("Transcript language").innerText(), /Use account default/);
  const spaceId = made.id;

  // The same journeys again for the pictures, in each theme and size.
  for (const nextTheme of ["light", "dark"]) {
    for (const nextSize of ["desktop", "phone"]) {
      await setLook(nextTheme, nextSize);
      await page.goto(`${origin}/dashboard/developer`);
      await trigger("Transcript language").waitFor();
      // Start every look from a saved Auto-detect, so choosing Urdu below is a change Save accepts.
      if (!/Auto-detect/.test(await trigger("Transcript language").innerText())) {
        await trigger("Transcript language").click();
        await page.getByRole("option", { name: /Auto-detect/ }).click();
        const saved = page.getByText("Transcript language saved", { exact: true });
        await saved.waitFor();
        await saved.waitFor({ state: "detached" });
      }
      await page.evaluate(() => window.localStorage.setItem("chalk.transcript-language.recent", '["ur","en","ar"]'));
      await shot("account-closed", account);
      await trigger("Transcript language").click();
      await shot("account-open", account);
      await search().fill("ur");
      await shot("account-searching", account);
      await search().fill("klingon");
      await shot("account-no-results", account);
      await search().fill("");
      for (let step = 0; step < 4; step++) await search().press("ArrowDown");
      await shot("account-keyboard", account);
      await search().press("Escape");
      await trigger("Transcript language").click();
      await slowly("dashboard-api/developer", "POST", async () => {
        await pickByTyping("urdu");
        await page.locator("[aria-busy=true]").waitFor();
        await shot("account-loading", account);
      });
      await page.getByText("Transcript language saved", { exact: true }).waitFor();
      await shot("account-selected", account);

      await page.goto(`${origin}/dashboard/call/${spaceId}`);
      await trigger("Transcript language").waitFor();
      const section = page.locator("#transcript-language");
      await shot("space-closed", section);
      await trigger("Transcript language").click();
      await shot("space-open", section);
      await search().press("Escape");

      // Home starts every look on the account default, whatever an earlier journey chose.
      await page.evaluate(() => window.localStorage.removeItem("chalk.transcript-language.new-call"));
      await page.goto(`${origin}/dashboard`);
      await slowly("dashboard-api/home", "POST", async () => {
        await page.getByRole("button", { name: "Start a call", exact: true }).first().click();
        await page.locator("[aria-busy=true]").first().waitFor();
        await shot("home-disabled", page.locator(".hhead"));
      });
      const ready = readyDialog();
      await ready.waitFor();
      await shot("home-ready", ready);
      await trigger("Transcript language").click();
      await shot("home-open", ready);
      await pickByTyping("urdu");
      await shot("home-selected", ready);
      await closeReadyDialog();
    }
  }
  console.log("PASS account, Space and new-call transcript languages work through the picker");
} finally {
  await cleanup();
}
