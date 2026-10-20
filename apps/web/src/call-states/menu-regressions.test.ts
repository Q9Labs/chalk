import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";

let origin: string;
let stop: (() => Promise<void>) | undefined;
let browser: Browser;
let page: Page;
const artifacts = process.env.MENU_ARTIFACTS;
const errors: string[] = [];
beforeAll(async () => {
  ({ origin, stop } = await startCallHarness());
  browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream=device-count=3"],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ["camera"] });
  page.on("pageerror", (error) => errors.push(error.message));
  if (artifacts) await mkdir(artifacts, { recursive: true });
}, 60_000);
afterEach(() => expect(errors).toEqual([]));
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await stop?.();
  }
});
async function load(state: string) {
  errors.length = 0;
  await page.goto(`${origin}/call-states.html?state=${state}${state.startsWith("shell-browser") ? "&browserMedia" : ""}`);
  await page.locator('[data-part="call-frame"]').waitFor();
}

it("previews and switches real local cameras while unpublished, then releases capture", async () => {
  await load("shell-browser-cameras");
  await page.getByRole("button", { name: "Turn on camera", exact: true }).filter({ visible: true }).waitFor();
  await page.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
  const preview = page.locator(".chalk-shell-preview video");

  await expect.poll(() => page.getByRole("menuitemradio").count()).toBeGreaterThanOrEqual(2);
  if (artifacts) await page.screenshot({ path: resolve(artifacts, "camera.png") });
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0]?.enabled)).toBe(true);
  const first = await preview.evaluate((video: HTMLVideoElement) => {
    const stream = video.srcObject;
    if (!(stream instanceof MediaStream)) throw new Error("Preview has no stream");
    return stream.getVideoTracks()[0]?.getSettings().deviceId;
  });
  expect(first).toBeTruthy();
  const time = await preview.evaluate((video: HTMLVideoElement) => video.currentTime);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(time);
  expect(await page.getByRole("menuitemradio").count()).toBeGreaterThanOrEqual(2);
  const previous = await preview.evaluateHandle((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : undefined));
  const second = await page.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput")[1]?.deviceId);
  await page.getByRole("menuitemradio").nth(1).click();
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0]?.getSettings().deviceId : undefined))).toBe(second);
  await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await expect.poll(() => previous.evaluate((value) => value?.readyState)).toBe("ended");
  await previous.dispose();
  // Keep the actual browser track, so removing the video alone cannot satisfy release.
  const track = await preview.evaluateHandle((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : undefined));
  if (artifacts) await page.screenshot({ path: resolve(artifacts, "camera.png") });
  await page.keyboard.press("Escape");
  await expect.poll(() => track.evaluate((value) => value?.readyState)).toBe("ended");
  await track.dispose();
  expect(await page.getByRole("button", { name: "Turn on camera", exact: true }).filter({ visible: true }).count()).toBe(1);
}, 30_000);

it("releases a preview that finishes opening after its menu closes", async () => {
  await load("shell-browser-cameras");
  await expect.poll(() => page.getByRole("button", { name: "Turn on camera", exact: true }).filter({ visible: true }).count()).toBe(1);
  // Wait for the fixture's retained disabled camera before delaying only preview capture.
  await page.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
  await expect.poll(() => page.getByRole("menuitemradio").count()).toBeGreaterThanOrEqual(2);
  await page.keyboard.press("Escape");
  const pending = await page.evaluateHandle(() => {
    const tracks: MediaStreamTrack[] = [];
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await capture(constraints);
      tracks.push(...stream.getTracks());
      await ready;
      return stream;
    };
    return { tracks, release: () => release?.() };
  });
  await page.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
  await expect.poll(() => pending.evaluate((value) => value.tracks.length)).toBe(1);
  await page.keyboard.press("Escape");
  await pending.evaluate((value) => value.release());
  await expect.poll(() => pending.evaluate((value) => value.tracks[0]?.readyState)).toBe("ended");
  await pending.dispose();
}, 30_000);

it("does not stop the call's camera when closing its borrowed preview", async () => {
  await load("shell-browser-camera-on");
  await page.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
  await expect.poll(() => page.getByRole("menuitemradio").count()).toBeGreaterThanOrEqual(2);
  const track = await page.locator(".chalk-shell-preview video").evaluateHandle((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : undefined));
  expect(await track.evaluate((value) => value?.readyState)).toBe("live");
  await page.keyboard.press("Escape");
  expect(await track.evaluate((value) => value?.readyState)).toBe("live");
  await track.dispose();
});

it("keeps shortcuts content throughout close without rendering a report dialog", async () => {
  await load("shell-call");
  await page.getByRole("button", { name: "Call details", exact: true }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }).waitFor();
  await page.evaluate(() => {
    document.documentElement.dataset.reportFlashed = "false";
    const observer = new MutationObserver(() => {
      if (document.querySelector(".chalk-shell-report")) document.documentElement.dataset.reportFlashed = "true";
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  // Slow the real exit animation so a one-frame title/content swap is observable.
  await page.addStyleTag({ content: ".chalk-shell-modal { transition-duration: 3s !important; animation-duration: 1s !important; }" });
  await page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
  await page.evaluate(() =>
    document
      .querySelector(".chalk-shell-modal")
      ?.getAnimations()
      .forEach((animation) => animation.pause()),
  );
  if (artifacts) await page.screenshot({ path: resolve(artifacts, "shortcuts.png") });
  expect(await page.locator("html").getAttribute("data-report-flashed")).toBe("false");
  expect(await page.getByText("Report a problem", { exact: true }).count()).toBe(0);
  expect(await page.getByLabel("What went wrong?", { exact: true }).count()).toBe(0);
  await page.evaluate(() =>
    document
      .querySelector(".chalk-shell-modal")
      ?.getAnimations()
      .forEach((animation) => animation.finish()),
  );
  await page.getByRole("dialog").waitFor({ state: "detached" });
}, 30_000);

it("keeps the call usable when browser camera capture is unavailable", async () => {
  await load("shell-call");
  await page.getByRole("button", { name: "Turn off camera", exact: true }).filter({ visible: true }).click();
  await page.evaluate(() => Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined }));
  await page.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
  await page.getByText("Camera preview unavailable. Check camera access.", { exact: true }).waitFor({ timeout: 3000 });
  expect(await page.locator('[data-part="call-frame"]').count()).toBe(1);
  expect(errors).toEqual([]);
  await page.keyboard.press("Escape");
});
