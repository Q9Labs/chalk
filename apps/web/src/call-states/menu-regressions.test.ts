import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { JSHandle } from "playwright";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";
import type {} from "./camera-enable-fixture";

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
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream=device-count=2"],
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

it("borrows the enabling camera when its menu opens before capture finishes", async () => {
  const racePage = await browser.newPage({ permissions: ["camera"], viewport: { width: 1440, height: 900 } });
  racePage.on("pageerror", (error) => errors.push(error.message));
  let race: JSHandle<Awaited<ReturnType<HTMLElementTagNameMap["chalk-camera-enable-fixture"]["mountPendingCamera"]>>> | undefined;
  try {
    await racePage.goto(`${origin}/call-states.html?state=shell-browser-permission&browserMedia`);
    await racePage.addScriptTag({ type: "module", url: `${origin}/src/call-states/camera-enable-fixture.tsx` });
    race = await racePage.evaluateHandle(async () => document.createElement("chalk-camera-enable-fixture").mountPendingCamera());
    await racePage.getByRole("button", { name: "Turn on camera", exact: true }).filter({ visible: true }).click();
    await expect.poll(() => race?.evaluate((value) => value.calls())).toBe(1);
    await racePage.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
    await racePage.locator(".chalk-shell-preview video").waitFor();
    await race?.evaluate((value) => value.allowCapture());
    const preview = racePage.locator(".chalk-shell-preview video");
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
    if (artifacts) await racePage.screenshot({ path: resolve(artifacts, "enable-pending.png") });
    expect(await race?.evaluate((value) => value.calls())).toBe(1);
    const enablingTrackId = await race?.evaluate((value) => value.tracks[0]?.id);
    expect(await preview.evaluate((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0]?.id : null))).toBe(enablingTrackId);
    await racePage.keyboard.press("Escape");
    expect(await race?.evaluate((value) => value.tracks[0]?.readyState)).toBe("live");
    await race?.evaluate((value) => value.allowPublish());
  } finally {
    await race?.evaluate((value) => value.dispose());
    await race?.dispose();
    await racePage.close();
  }
}, 30_000);

it("discovers both cameras when private preview reveals the permission-restricted inventory", async () => {
  const privatePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  privatePage.on("pageerror", (error) => errors.push(error.message));
  try {
    // Chromium fake UI pregrants capture. Model its pre-permission inventory while keeping both cameras and capture native.
    await privatePage.addInitScript(() => {
      let permitted = false;
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await capture(constraints);
        permitted = true;
        return stream;
      };
      navigator.mediaDevices.enumerateDevices = async () => (permitted ? enumerate() : [{ deviceId: "", groupId: "", kind: "videoinput", label: "", toJSON: () => ({}) }]);
    });
    await privatePage.goto(`${origin}/call-states.html?state=shell-browser-permission&browserMedia`);
    await privatePage.getByRole("button", { name: "Turn on camera", exact: true }).filter({ visible: true }).waitFor();
    await expect.poll(() => privatePage.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput").every((device) => !device.label))).toBe(true);
    const grant = await privatePage.evaluateHandle(() => {
      let allow = () => {};
      const granted = new Promise<void>((resolve) => {
        allow = resolve;
      });
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => granted.then(() => capture(constraints));
      return () => allow();
    });
    await privatePage.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
    if (artifacts) await privatePage.screenshot({ path: resolve(artifacts, "permission-before.png") });
    await grant.evaluate((allow) => allow());
    await grant.dispose();
    const preview = privatePage.locator(".chalk-shell-preview video");
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
    if (artifacts) await privatePage.screenshot({ path: resolve(artifacts, "permission-after.png") });
    await expect.poll(() => privatePage.getByRole("menuitemradio").count()).toBe(2);
    await privatePage.getByRole("menuitemradio", { name: "fake_device_0", exact: true }).waitFor();
    await privatePage.getByRole("menuitemradio", { name: "fake_device_1", exact: true }).waitFor();
    const second = await privatePage.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "videoinput")[1]?.deviceId);
    await privatePage.getByRole("menuitemradio").nth(1).click();
    await expect.poll(() => preview.evaluate((video: HTMLVideoElement) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0]?.getSettings().deviceId)).toBe(second);
    expect(await privatePage.getByRole("button", { name: "Turn on camera", exact: true }).filter({ visible: true }).count()).toBe(1);
    const track = await preview.evaluateHandle((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : undefined));
    await privatePage.keyboard.press("Escape");
    await expect.poll(() => track.evaluate((value) => value?.readyState)).toBe("ended");
    await track.dispose();
  } finally {
    await privatePage.close();
  }
}, 30_000);

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
  await expect
    .poll(() =>
      preview.evaluate((video: HTMLVideoElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const context = canvas.getContext("2d");
        if (!context) return false;
        context.drawImage(video, 0, 0, 16, 16);
        return context.getImageData(0, 0, 16, 16).data.some((value, index) => index % 4 !== 3 && value > 20);
      }),
    )
    .toBe(true);
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

async function openPublishedCamera() {
  await load("shell-browser-camera-on");
  await page.getByRole("button", { name: "Select camera", exact: true }).filter({ visible: true }).click();
  await expect.poll(() => page.getByRole("menuitemradio").count()).toBeGreaterThanOrEqual(2);
}

it("does not stop the call's camera when closing its borrowed preview", async () => {
  await openPublishedCamera();
  const track = await page.locator(".chalk-shell-preview video").evaluateHandle((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : undefined));
  expect(await track.evaluate((value) => value?.readyState)).toBe("live");
  await page.keyboard.press("Escape");
  expect(await track.evaluate((value) => value?.readyState)).toBe("live");
  await track.dispose();
});

it("keeps an active preview on the published camera when another device is selected", async () => {
  await openPublishedCamera();
  const preview = page.locator(".chalk-shell-preview video");
  const published = await preview.evaluateHandle((video: HTMLVideoElement) => (video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks()[0] : undefined));
  expect(await published.evaluate((track) => track?.enabled && track.readyState === "live")).toBe(true);
  const captures = await page.evaluateHandle(() => {
    const calls: MediaStreamConstraints[] = [];
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      calls.push(constraints ?? {});
      return capture(constraints);
    };
    return calls;
  });
  await page.getByRole("menuitemradio").nth(1).click();
  await expect.poll(() => page.getByLabel("Last shell command").textContent()).toContain("Selected camera:");
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  // Selection alone does not replace the SDK's published track.
  expect(await captures.evaluate((calls) => calls.length)).toBe(0);
  expect(await preview.evaluate((video: HTMLVideoElement, track) => video.srcObject instanceof MediaStream && video.srcObject.getVideoTracks()[0] === track, published)).toBe(true);
  await page.keyboard.press("Escape");
  expect(await published.evaluate((track) => track?.enabled && track.readyState === "live")).toBe(true);
  await captures.dispose();
  await published.dispose();
});

it("keeps shortcuts content throughout close without rendering a report dialog", async () => {
  await load("shell-report");
  await page.evaluate(() => {
    document.documentElement.dataset.reportFlashed = "false";
    const observer = new MutationObserver(() => {
      if (document.querySelector(".chalk-shell-report")) document.documentElement.dataset.reportFlashed = "true";
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.getByRole("button", { name: "Call details", exact: true }).click();
  await page.getByRole("button", { name: "Keyboard shortcuts", exact: true }).click();
  await page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true }).waitFor();
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
  expect(await page.getByRole("dialog", { name: "Report a problem", exact: true }).count()).toBe(0);
  expect(await page.getByLabel("What went wrong?", { exact: true }).count()).toBe(0);
  await page.evaluate(() =>
    document
      .querySelector(".chalk-shell-modal")
      ?.getAnimations()
      .forEach((animation) => animation.finish()),
  );
  await page.getByRole("dialog").waitFor({ state: "detached" });
}, 30_000);

it("opens Report a problem from call details and sends the supplied callback", async () => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await load("shell-report");
    await page.getByRole("button", { name: "Call details", exact: true }).click();
    await page.getByRole("button", { name: "Report a problem", exact: true }).click();
    const report = page.getByRole("dialog", { name: "Report a problem", exact: true });
    await report.getByLabel("What went wrong?", { exact: true }).fill("Camera preview needs help");
    if (artifacts) await page.screenshot({ path: resolve(artifacts, `report-menu-${width}.png`) });
    await report.getByRole("button", { name: "Send", exact: true }).click();
    const sent = page.getByRole("dialog", { name: "Sent", exact: true });
    await sent.getByRole("heading", { name: "Sent", exact: true }).waitFor();
    await expect.poll(() => page.getByLabel("Last shell command").textContent()).toBe("Reported: Camera preview needs help");
    await sent.getByRole("button", { name: "Done", exact: true }).click();
    await sent.waitFor({ state: "detached" });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
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
