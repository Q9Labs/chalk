import { expect, type Screen } from "e2e";
import { test, type Browser } from "@e2e-dev/web";
import { chromium, devices, type Page } from "playwright";
import { join } from "node:path";
import { installAnnotationCaptureFixture } from "../../../scripts/web-proof/media.mjs";
import { showCallControls } from "./call-controls.mjs";
import { startAndJoinCall } from "./dashboard/call-steps.mjs";

const canvas = '[data-part="screen-annotation-layer"]';

const bounds = () => {
  const box = document.querySelector('[data-part="screen-annotation-layer"]')?.getBoundingClientRect();
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
};

function hasInk() {
  const canvas = document.querySelector('[data-part="screen-annotation-layer"]');
  if (!(canvas instanceof HTMLCanvasElement)) return false;
  return (
    canvas
      .getContext("2d")
      ?.getImageData(0, 0, canvas.width, canvas.height)
      .data.some((alpha, index) => index % 4 === 3 && alpha > 50) ?? false
  );
}

function inkCenterY() {
  const canvas = document.querySelector('[data-part="screen-annotation-layer"]');
  if (!(canvas instanceof HTMLCanvasElement)) return -1;
  const pixels = canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data;
  if (!pixels) return -1;
  let weight = 0;
  let sum = 0;
  for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += 1) {
    const alpha = pixels[pixel * 4 + 3] ?? 0;
    weight += alpha;
    sum += alpha * Math.floor(pixel / canvas.width);
  }
  return weight > 0 ? sum / weight / canvas.height : -1;
}

async function openAnnotationFixture(browser: Browser, screen: Screen) {
  await browser.goto("/call-states.html?state=screen-annotation");
  await screen.getByRole("button", "Draw", { exact: true }).click();
  return annotationBounds(browser);
}

async function annotationBounds(browser: Browser) {
  const box = await browser.evaluate(bounds);
  if (!box) throw new Error("Annotation canvas did not mount");
  return box;
}

async function stroke(browser: Browser, portion = 0.38) {
  const box = await annotationBounds(browser);
  const y = box.y + box.height * portion;
  await browser.mouse.move(box.x + box.width * 0.3, y);
  await browser.mouse.down();
  for (const ratio of [0.38, 0.47, 0.53, 0.64]) await browser.mouse.move(box.x + box.width * ratio, y);
  await browser.mouse.up();
  await browser.mouse.move(10, 10);
}

test("draw, fade, keep, undo, redo, save, download and clear a matched publication", async ({ app, browser, screen }) => {
  const box = await openAnnotationFixture(browser, screen);
  const frameAspect = 1600 / 900;
  const fitHeight = Math.min(box.height, box.width / frameAspect);
  const fillHeight = Math.max(box.height, box.width / frameAspect);
  expect((box.height - fitHeight) / 2).toBeGreaterThan(10);
  await stroke(browser, (box.height - fitHeight) / 4 / box.height);
  await expect.poll(() => browser.evaluate(hasInk)).toBe(false);
  await stroke(browser);
  await expect.poll(() => browser.evaluate(hasInk), { timeout: 1500 }).toBe(true);
  await expect.poll(() => browser.evaluate(hasInk), { timeout: 3500 }).toBe(false);

  await screen.getByRole("button", "More", { exact: true }).click();
  await screen.getByRole("menuitemcheckbox", "Marks fade").click();
  await browser.keyboard.press("Escape");
  const fitY = 0.34;
  await stroke(browser, fitY);
  await expect.poll(() => browser.evaluate(hasInk)).toBe(true);
  await screen.getByRole("button", "Undo", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(false);
  await screen.getByRole("button", "More", { exact: true }).click();
  await screen.getByRole("menuitem", "Redo", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(true);
  await screen.getByRole("button", "More", { exact: true }).click();
  await screen.getByRole("menuitem", /^Save to board/).click();
  await expect(browser.locator('[role="status"]').filter({ hasText: "1 accepted marks sent to board" })).toBeVisible();
  const png = await browser.waitForDownload(async () => {
    await screen.getByRole("button", "More", { exact: true }).click();
    await screen.getByRole("menuitem", /^Download image/).click();
  });
  expect(png.suggestedFilename).toBe("chalk-annotated-screen.png");
  await expect.poll(async () => Math.abs((await browser.evaluate(inkCenterY)) - fitY)).toBeLessThan(0.012);
  await app.screenshot("viewer-kept-fit");
  await screen.getByRole("button", "Fill the tile", { exact: true }).click();
  const fillY = 0.5 + ((fitY - 0.5) * fillHeight) / fitHeight;
  await expect.poll(async () => Math.abs((await browser.evaluate(inkCenterY)) - fillY)).toBeLessThan(0.012);
  await app.screenshot("viewer-kept-fill");
  await screen.getByRole("button", "More", { exact: true }).click();
  await screen.getByRole("menuitem", "Clear my marks", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(false);
});

test("revoke during a gesture, ask first, allow, then the sharer shows marks through Chalk Helper", async ({ app, browser, screen }) => {
  const box = await openAnnotationFixture(browser, screen);
  await browser.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.4);
  await browser.mouse.down();
  await browser.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await browser.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((candidate) => candidate.textContent === "Require approval");
    button?.click();
    return Boolean(button);
  });
  await browser.mouse.up();
  await expect(screen.getByRole("button", "Draw", { exact: true })).not.toBeVisible();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(false);
  await screen.getByRole("button", "Ask to draw", { exact: true }).click();
  await expect(browser.locator('[role="status"]').filter({ hasText: "Asked Sara" })).toBeVisible();
  await app.screenshot("viewer-request");

  await screen.getByRole("button", "View as Sara", { exact: true }).click();
  await screen.getByRole("button", "Allow Omar to draw", { exact: true }).click();
  await screen.getByRole("button", "View as Omar", { exact: true }).click();
  await screen.getByRole("button", "Draw", { exact: true }).click();
  await screen.getByRole("button", "More", { exact: true }).click();
  await screen.getByRole("menuitemcheckbox", "Marks fade").click();
  await browser.keyboard.press("Escape");
  await stroke(browser);
  await screen.getByRole("button", "View as Sara", { exact: true }).click();
  await expect.poll(() => browser.evaluate(hasInk)).toBe(true);
});

test("the sharer connects Chalk Helper to show marks on their own screen", async ({ app, browser, screen }) => {
  await browser.goto("/call-states.html?state=share-sharer-helper");
  await screen.getByRole("button", "Show on my screen", { exact: true }).click();
  await screen.getByRole("button", "Connect Chalk Helper", { exact: true }).click();
  await expect(browser.locator('[role="status"]').filter({ hasText: "Couldn’t reach Chalk Helper on this device." })).toBeVisible();
  await browser.locator("input[autocomplete=off]").fill("HJKX-4821");
  await screen.getByRole("button", "Find device", { exact: true }).click();
  await expect(browser.locator('[data-part="annotation-helper-offer"]')).toContainText("Allow Demo Mac to show marks on this share?");
  await screen.getByRole("button", "Allow this device", { exact: true }).click();
  await expect(browser.locator('[role="status"]').filter({ hasText: "Marks show on your screen" })).toBeVisible();
  await app.screenshot("sharer-helper-approval");
});

async function joinGuest(host: Page, page: Page, invite: string, name: string) {
  await page.goto(invite);
  await page.getByLabel("Your name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await host.getByRole("button", { name: `Let ${name} in`, exact: true }).click();
  await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: 30_000 });
}

async function chooseShare(page: Page, source: "Window" | "Entire screen", installer?: string) {
  await showCallControls(page);
  await page.getByRole("button", { name: "Share options", exact: true }).click();
  const download = page.getByRole("menuitem", { name: /^Get Chalk Helper\b/ });
  if (installer) expect(await download.getAttribute("href")).toBe(installer);
  else expect(await download.count()).toBe(0);
  await page.getByRole("menuitemradio", { name: source, exact: true }).click();
}

async function drawLiveMark(page: Page) {
  await page.getByRole("button", { name: "Draw", exact: true }).click();
  const box = await page.locator(canvas).boundingBox();
  if (!box) throw new Error("No annotation canvas on the received screen share");
  const y = box.y + box.height * 0.42;
  await page.mouse.move(box.x + box.width * 0.34, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.58, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(hasInk)).toBe(true);
}

async function stopShare(page: Page) {
  await showCallControls(page);
  await page.locator('[data-part="share-split"]').getByRole("button", { name: "Stop sharing", exact: true }).click();
}

test("live annotation: a dashboard host and a guest each get Helper before and after viewers draw; mobile web does not", async () => {
  const ownerState = process.env.CHALK_ANNOTATION_OWNER_STATE;
  const origin = process.env.CHALK_ANNOTATION_WEB_URL;
  const installer = process.env.VITE_CHALK_HELPER_INSTALL_URL;
  if (!origin || !installer) return test.skip(true, "Requires the annotation-enabled local stack and install URL.");
  const evidence = process.env.CHALK_ANNOTATION_EVIDENCE_DIR;
  const browser = await chromium.launch({ args: ["--no-proxy-server"] });
  try {
    const hostContext = await browser.newContext({ storageState: ownerState, permissions: ["clipboard-read", "clipboard-write"], viewport: { width: 1440, height: 960 } });
    const guestContext = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    // Desktop layout and a capture fixture force the mobile exclusion to use device
    // identity rather than a narrow viewport or an absent capture API.
    const mobileContext = await browser.newContext({ ...devices["iPhone 15"], viewport: { width: 1440, height: 960 } });
    await Promise.all([hostContext, guestContext, mobileContext].map((context, index) => installAnnotationCaptureFixture(context, index)));
    // Same live media path, without the Chromium-only Document PiP API.
    await guestContext.addInitScript(() => Object.defineProperty(window, "documentPictureInPicture", { value: undefined }));
    const [host, guest, mobile] = await Promise.all([hostContext.newPage(), guestContext.newPage(), mobileContext.newPage()]);
    if (!ownerState) {
      // The dev stack has its own local identity provider; CI passes the dashboard fixture's session instead.
      await host.goto(new URL("/dashboard/sign-in", origin).href);
      await host.getByRole("button", { name: "Continue with Google", exact: true }).click();
      await host.getByRole("link", { name: "Ada", exact: true }).click();
      await host.getByRole("button", { name: "Start a call", exact: true }).first().waitFor();
    }
    await startAndJoinCall(host, origin);
    const detailsButton = host.getByRole("button", { name: "Call details", exact: true });
    if ((await detailsButton.getAttribute("aria-expanded")) !== "true") await detailsButton.click();
    const details = host.getByRole("dialog", { name: "Call details", exact: true });
    await details.getByRole("button", { name: /Copy invite link/ }).click();
    await details.getByText("Link copied", { exact: true }).waitFor();
    const invite = await host.evaluate(() => navigator.clipboard.readText());
    await details.getByRole("button", { name: "Close", exact: true }).click();
    await joinGuest(host, guest, invite, "Desktop Guest");
    await joinGuest(host, mobile, invite, "Mobile Guest");

    const helperCard = (page: Page) => page.locator('[data-part="annotation-helper-offer"]');
    const intro = "Viewers can draw on your share. Use Chalk Helper to see their marks on your screen.";
    await chooseShare(host, "Window", installer);
    await helperCard(host).getByText(intro, { exact: true }).waitFor();
    expect(await helperCard(host).getByRole("link", { name: "Get Chalk Helper" }).getAttribute("href")).toBe(installer);
    if (origin.startsWith("https:")) await helperCard(host).getByRole("button", { name: "Connect", exact: true }).waitFor();
    if (evidence) await host.screenshot({ path: join(evidence, "host-window-prompt.png") });
    await helperCard(host).getByRole("button", { name: "Not now", exact: true }).click();
    await helperCard(host).waitFor({ state: "hidden" });
    await mobile.getByRole("button", { name: "Draw", exact: true }).waitFor();
    expect(await helperCard(mobile).count()).toBe(0);
    await drawLiveMark(guest);
    await host.locator('[data-part="sharer-title"]').getByText("Desktop is drawing", { exact: true }).waitFor();
    if (evidence) await host.screenshot({ path: join(evidence, "host-window-drawing.png") });
    await stopShare(host);
    await helperCard(host).waitFor({ state: "detached" });

    await host.evaluate(() => localStorage.setItem("fixture-opaque-window", "1"));
    await chooseShare(host, "Window", installer);
    await host.getByRole("button", { name: "Show on my screen", exact: true }).click();
    await helperCard(host)
      .getByText(/Share your entire screen to use it/)
      .waitFor();
    expect(await helperCard(host).getByRole("button", { name: "Connect", exact: true }).count()).toBe(0);
    if (evidence) await host.screenshot({ path: join(evidence, "opaque-window-helper-guidance.png") });
    await stopShare(host);
    await helperCard(host).waitFor({ state: "detached" });

    await chooseShare(guest, "Window", installer);
    await helperCard(guest).getByText(intro, { exact: true }).waitFor();
    expect(await guest.getByText("Marks aren’t visible on this device", { exact: true }).count()).toBe(0);
    if (evidence) await guest.screenshot({ path: join(evidence, "guest-window-no-pip-prompt.png") });
    await drawLiveMark(host);
    await helperCard(guest)
      .getByText(/is drawing on your share/)
      .waitFor();
    if (evidence) await guest.screenshot({ path: join(evidence, "guest-window-drawing.png") });
    if (origin.startsWith("https:")) {
      await helperCard(guest).getByRole("button", { name: "Connect Chalk Helper", exact: true }).click();
      await helperCard(guest).getByText("Couldn’t reach Chalk Helper on this device.", { exact: true }).waitFor();
      expect(await helperCard(guest).getByRole("button", { name: "Find device", exact: true }).count()).toBe(0);
      await helperCard(guest).getByRole("button", { name: "Not now", exact: true }).click();
    }
    await stopShare(guest);
    await helperCard(guest).waitFor({ state: "detached" });

    await chooseShare(host, "Entire screen", installer);
    await host.getByRole("button", { name: "Show on my screen", exact: true }).waitFor();
    expect(await helperCard(host).count()).toBe(0);
    await host.getByRole("button", { name: "Show on my screen", exact: true }).click();
    await helperCard(host).getByText(intro, { exact: true }).waitFor();
    await stopShare(host);
    await helperCard(host).waitFor({ state: "detached" });

    await chooseShare(mobile, "Window");
    await mobile.locator('[data-part="screen-annotation-controls"][data-local]').waitFor();
    await host.getByRole("button", { name: "Draw", exact: true }).waitFor();
    if (evidence) await host.screenshot({ path: join(evidence, "web-viewer-annotate.png") });
    await drawLiveMark(host);
    expect(await helperCard(mobile).count()).toBe(0);
    if (evidence) {
      await mobile.setViewportSize(devices["iPhone 15"].viewport);
      await mobile.screenshot({ path: join(evidence, "mobile-web-no-helper.png") });
      await mobile.setViewportSize({ width: 1440, height: 960 });
    }
    await stopShare(mobile);
  } finally {
    await browser.close();
  }
});
