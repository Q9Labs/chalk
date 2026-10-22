import { strict as assert } from "node:assert";
import { startCallHarness } from "../src/call-states/browser-harness.ts";
import { chromium } from "playwright";

// Layout facts from the approved call and board mockups that only a real browser can measure.
const { origin, stop } = await startCallHarness();
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  await page.goto(`${origin}/call-states.html?state=name-needed`);
  const name = page.locator("#join-display-name");
  await name.waitFor();
  // Tailwind's radius scale once read a --radius token that no stylesheet defined, so every rounded-* rendered square.
  assert.equal(await name.evaluate((input) => getComputedStyle(input).borderRadius), "12px", "the name field keeps the 12px field radius");

  for (const viewport of [{ width: 1440, height: 900 }]) {
    await page.setViewportSize(viewport);
    await page.goto(`${origin}/call-states.html?state=board-empty-dark`);
    const zoom = page.locator(".chalk-board-zoom");
    await zoom.waitFor();
    // The island docks at the bottom of the stage, in the same row as the zoom control.
    const controlsTop = Math.min(...(await page.locator(".chalk-board-island, .chalk-board-zoom").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))));
    // The toast stack is anchored by its bottom edge, so that edge is where the first toast sits.
    const toastBottom = await page.locator('[data-part="toast-stack"]').evaluate((stack) => stack.getBoundingClientRect().bottom);
    assert.ok(toastBottom <= controlsTop - 8, `at ${viewport.width}px, toasts sit above the board's bottom controls (toasts end at ${toastBottom}px, controls start at ${controlsTop}px)`);
  }

  // A past-session recording shows whole and keeps its shape in the 16:9 player, so a portrait or small 4:3 frame is letterboxed, not stretched, cropped or left at its own size.
  for (const frame of [
    { width: 360, height: 640 },
    { width: 160, height: 120 },
  ]) {
    await page.setContent(`<link rel="stylesheet" href="${origin}/src/styles/dashboard.css"><div class="site"><div class="dash"><div class="player" style="width: 960px"><video muted></video></div></div></div>`, { waitUntil: "load" });
    await page.evaluate(async ({ width, height }) => {
      const canvas = Object.assign(document.createElement("canvas"), { width, height });
      const context = canvas.getContext("2d");
      setInterval(() => {
        context.fillStyle = "#ff0000";
        context.fillRect(0, 0, width, height);
      }, 50);
      const video = document.querySelector("video");
      video.srcObject = canvas.captureStream(20);
      await video.play();
      if (!video.videoWidth) await new Promise((done) => video.addEventListener("resize", done, { once: true }));
    }, frame);
    await page.waitForTimeout(200);
    const shot = (await page.locator(".player").screenshot()).toString("base64");
    // The painted frame is the red box in the screenshot; the player's own background is near black.
    const painted = await page.evaluate(async (png) => {
      const image = new Image();
      image.src = `data:image/png;base64,${png}`;
      await image.decode();
      const canvas = Object.assign(document.createElement("canvas"), { width: image.width, height: image.height });
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, image.width, image.height);
      let [left, top, right, bottom] = [Infinity, Infinity, -1, -1];
      for (let y = 0; y < image.height; y += 1) {
        for (let x = 0; x < image.width; x += 1) {
          const at = (y * image.width + x) * 4;
          if (data[at] > 200 && data[at + 1] < 60 && data[at + 2] < 60) [left, top, right, bottom] = [Math.min(left, x), Math.min(top, y), Math.max(right, x), Math.max(bottom, y)];
        }
      }
      return { width: right - left + 1, height: bottom - top + 1 };
    }, shot);
    const scale = Math.min(960 / frame.width, 540 / frame.height);
    const expected = { width: frame.width * scale, height: frame.height * scale };
    assert.ok(Math.abs(painted.width - expected.width) <= 2 && Math.abs(painted.height - expected.height) <= 2, `a ${frame.width}x${frame.height} recording shows whole at ${Math.round(expected.width)}x${Math.round(expected.height)} in the player (painted ${painted.width}x${painted.height})`);
  }

  console.log("PASS: rounded fields, toasts above the board island, recordings keep their shape in the player");
} finally {
  try {
    await browser?.close();
  } finally {
    await stop();
  }
}
