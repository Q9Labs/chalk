import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { startCallHarness } from "./browser-harness";

vi.setConfig({ testTimeout: 30_000 });

let origin: string;
let stop: (() => Promise<void>) | undefined;
let browser: Browser;
let page: Page;
beforeAll(async () => {
  ({ origin, stop } = await startCallHarness());
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  page.on("pageerror", (error) => console.error("Stage harness page error:", error.message));
}, 60_000);
afterEach(async () => {
  if (!process.env.STAGE_ARTIFACTS || !page || page.isClosed()) return;
  await mkdir(process.env.STAGE_ARTIFACTS, { recursive: true });
  const name = (expect.getState().currentTestName ?? "stage").replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  await page.screenshot({ path: resolve(process.env.STAGE_ARTIFACTS, `${name}.png`) });
});
afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await stop?.();
  }
});
async function open(state: string) {
  await page.goto(`${origin}/call-states.html?state=${state}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("stage").waitFor({ timeout: 20_000 });
}

it("shares the persistent mirror preference between the local stage camera and its preview", async () => {
  await open("foundation-dark");
  const camera = page.getByRole("button", { name: "Select camera", exact: true });
  const toggle = page.getByRole("menuitemcheckbox", { name: "Mirror my video", exact: true });
  const local = page.locator('[data-tour="local-video"] video');
  const remote = page.locator('[data-tour="video-grid"][role="region"] video').first();
  const check = async (mirrored: boolean) => {
    expect(await toggle.isEnabled()).toBe(true);
    expect(await toggle.getAttribute("aria-checked")).toBe(String(mirrored));
    expect(await local.evaluate((video) => getComputedStyle(video.parentElement!).scale)).toBe(mirrored ? "-1 1" : "none");
    expect(await remote.evaluate((video) => getComputedStyle(video.parentElement!).scale)).toBe("none");
    expect(await page.locator(".chalk-device-menu video").evaluate((video) => getComputedStyle(video).transform)).toBe(mirrored ? "matrix(-1, 0, 0, 1, 0, 0)" : "none");
  };
  try {
    await camera.click();
    await check(true);
    await toggle.click();
    await check(false);
    await page.reload();
    await camera.click();
    await check(false);
    await toggle.click();
    await check(true);
    await page.reload();
    await camera.click();
    await check(true);
  } finally {
    await page.evaluate(() => localStorage.removeItem("chalk_mirror"));
  }
});

it("keeps every camera and shared video mounted while switching Spotlight and Grid", async () => {
  await open("stage-share-aspect-2");
  const videos = await page.locator("video").elementHandles();
  expect(videos.length).toBe(7);
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page.getByRole("button", { name: "Spotlight", exact: true }).click();
  for (const video of videos) expect(await video.evaluate((element) => element.isConnected)).toBe(true);
  expect(await page.locator("video").count()).toBe(7);
});
it.each([3, 5, 7, 12])("fills Grid with %i people and exactly 8px gutters", async (count) => {
  await open(`stage-grid-${count}`);
  const result = await page.getByTestId("stage").evaluate((stage) => {
    const box = stage.getBoundingClientRect();
    const frames = Array.from(stage.querySelectorAll<HTMLElement>("[data-stage-item]:not([aria-hidden=true])"), (element) => element.getBoundingClientRect());
    const rows = Array.from(new Set(frames.map((frame) => frame.y)), (y) => frames.filter((frame) => frame.y === y));
    return {
      count: frames.length,
      filled: Array.from(rows.values()).every((row) => Math.abs((row[0]?.left ?? 0) - box.left) < 1 && Math.abs((row.at(-1)?.right ?? 0) - box.right) < 1 && row.slice(1).every((frame, index) => Math.abs(frame.left - (row[index]?.right ?? 0) - 8) < 1)),
      height: Math.abs(Math.max(...frames.map((frame) => frame.bottom)) - box.bottom) < 1,
    };
  });
  expect(result).toEqual({ count, filled: true, height: true });
});
it("refits people beside portrait content and restores them when sharing stops", async () => {
  await open("stage-share-aspect-0");
  const screen = page.locator('[data-stage-item="screen-share:stage-1"]');
  const main = await screen.boundingBox();
  const person = await page.locator('[data-stage-item="stage-0"]').boundingBox();
  expect(main && person && person.x >= main.x + main.width + 7).toBe(true);
  await page.getByRole("button", { name: "Stop fixture share", exact: true }).click();
  await expect.poll(() => screen.count()).toBe(0);
  expect(await page.getByRole("button", { name: "Video tile for You", exact: true }).isVisible()).toBe(true);
});
it("keeps a pinned person large in Spotlight even while a screen is shared", async () => {
  await open("stage-share-aspect-2");
  const tile = page.getByRole("button", { name: "Video tile for Akash", exact: true });
  await tile.click();
  expect(await tile.getAttribute("aria-pressed")).toBe("true");
  expect(await page.locator('[data-stage-item="stage-2"]').getAttribute("data-stage-role")).toBe("primary");
  const share = page.locator('[data-stage-item="screen-share:stage-1"]');
  expect(await share.getAttribute("aria-hidden")).not.toBe("true");
  expect(await share.getAttribute("data-stage-role")).toBe("strip");
  await page.getByRole("button", { name: "Add participant", exact: true }).click();
  expect(await share.getAttribute("aria-hidden")).not.toBe("true");
  expect(await page.locator('[data-stage-item="stage-2"]').getAttribute("data-stage-role")).toBe("primary");
});
it("shows a live local preview and Stop sharing ends it", async () => {
  await open("stage-share-local");
  await page.getByRole("group", { name: "Your share", exact: true }).waitFor();
  expect(await page.getByText("You’re sharing your screen", { exact: true }).isVisible()).toBe(true);
  const preview = page.locator('[data-stage-item="screen-share:stage-0"] video');
  await expect.poll(() => preview.evaluate((video) => (video instanceof HTMLVideoElement ? video.readyState : 0))).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await expect.poll(() => page.getByRole("group", { name: "Your share", exact: true }).count()).toBe(0);
});
it("uses a 96 by 128 picture-in-picture only for two-person phone Spotlight", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open("stage-duo");
  const box = await page.locator('[data-stage-role="strip"]').boundingBox();
  expect(box?.width).toBe(96);
  expect(box?.height).toBe(128);
  if (process.env.STAGE_ARTIFACTS) {
    await mkdir(process.env.STAGE_ARTIFACTS, { recursive: true });
    await page.screenshot({ path: resolve(process.env.STAGE_ARTIFACTS, "stage-duo-phone.png") });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
});

it("cancels a departing tile's fade when the same participant immediately rejoins", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open("stage-grid-6");
  await page.getByRole("button", { name: "Remove participant", exact: true }).click();
  await page.getByRole("button", { name: "Add participant", exact: true }).click();
  const returning = page.locator('[data-stage-item="stage-5"]');
  await expect.poll(() => returning.evaluate((tile) => getComputedStyle(tile).opacity)).toBe("1");
  expect(await returning.evaluate((tile) => tile.getAnimations().some((animation) => animation.id === "stage-exit"))).toBe(false);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

it("removes departed cameras even while the remaining call keeps changing layout", async () => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await open("stage-grid-6");
  await page.getByRole("button", { name: "Remove participant", exact: true }).click();
  await page.evaluate(async () => {
    const until = performance.now() + 400;
    while (performance.now() < until) {
      const button = Array.from(document.querySelectorAll("button")).find((element) => element.textContent === "Grid" || element.textContent === "Spotlight");
      button?.click();
      await new Promise((done) => setTimeout(done, 30));
    }
  });
  expect(await page.locator('[data-stage-item="stage-5"]').count()).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
});

it("numbers raised hands only while multiple people have a hand raised", async () => {
  await open("stage-grid-6");
  expect(await page.getByRole("img", { name: "Hand raised", exact: true }).count()).toBe(1);
  await page.getByRole("button", { name: "Raise second hand", exact: true }).click();
  expect(await page.getByRole("img", { name: "Hand raised, number 1", exact: true }).count()).toBe(1);
  expect(await page.getByRole("img", { name: "Hand raised, number 2", exact: true }).count()).toBe(1);
  await page.getByRole("button", { name: "Lower second hand", exact: true }).click();
  expect(await page.getByRole("img", { name: "Hand raised", exact: true }).count()).toBe(1);
});

it("keeps the first share large until another sharer is selected", async () => {
  await open("stage-share-two");
  const switcher = page.getByRole("group", { name: "Whose screen is big", exact: true });
  expect(await switcher.getByRole("button", { name: "Nora", exact: true }).getAttribute("aria-pressed")).toBe("true");
  await switcher.getByRole("button", { name: "Akash", exact: true }).click();
  expect(await page.locator('[data-stage-item="screen-share:stage-2"]').getAttribute("data-stage-role")).toBe("primary");
  expect(await page.locator('[data-stage-item="screen-share:stage-1"]').getAttribute("aria-hidden")).not.toBe("true");
});

it("uses supplied voice level for the ring and mirrors only the self camera", async () => {
  await open("stage-grid-6");
  const ring = page.locator('[data-stage-item="stage-1"] [data-part="speaking-ring"]');
  await page.getByRole("button", { name: "Change fixture voice level", exact: true }).click();
  await expect.poll(() => ring.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeCloseTo(0.37);
  await page.getByRole("button", { name: "Change fixture voice level", exact: true }).click();
  await expect.poll(() => ring.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeCloseTo(0.93);
  expect(await page.locator('[data-stage-item="stage-0"] video').evaluate((video) => (video.parentElement ? getComputedStyle(video.parentElement).scale.split(" ")[0] : null))).toBe("-1");
  expect(await page.locator('[data-stage-item="stage-1"] video').evaluate((video) => (video.parentElement ? getComputedStyle(video.parentElement).scale.split(" ")[0] : null))).toBe("none");
});

it("pins from the phone options row and refits instantly with reduced motion", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open("stage-spotlight");
  await page.getByRole("button", { name: "Video tile for Akash", exact: true }).click();
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  expect(await page.locator('[data-stage-item="stage-2"]').getAttribute("data-stage-role")).toBe("primary");
  expect(await page.locator('[data-stage-item="stage-2"]').evaluate((element) => element.getAnimations().length)).toBe(0);
  // Base UI removes closed popups on its next animation frame, even without motion.
  expect(await page.locator('[role="dialog"][data-open]').count()).toBe(0);
  expect(await page.getByRole("dialog").evaluateAll((dialogs) => dialogs.every((dialog) => dialog.hasAttribute("data-closed") && dialog.hasAttribute("data-ending-style") && dialog.getAnimations().length === 0))).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
});

it("labels audio only on a remote share that includes it", async () => {
  await open("stage-share-aspect-2");
  expect(await page.getByLabel("With share audio", { exact: true }).count()).toBe(0);
  await open("stage-share-audio");
  expect(await page.getByLabel("With share audio", { exact: true }).count()).toBe(1);
  await open("stage-share-local");
  expect(await page.getByLabel("With share audio", { exact: true }).count()).toBe(0);
});

it.each(["dark", "light"])("the board follow proof action follows Nora in %s", async (scheme) => {
  const state = `board-follow-${scheme}`;
  await open(state);
  const action = await page.evaluate((id) => window.__CALL_STATES__?.find((entry) => entry.id === id)?.actions?.[0], state);
  if (!action || !("click" in action)) throw new Error("Board follow proof has no click action");
  await page.getByRole(action.role ?? "button", { name: action.click, exact: true }).click({ timeout: 5000 });
  await page.getByText("Following Nora", { exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "Stop following Nora", exact: true }).isVisible()).toBe(true);
});

it("reads the real engine history for keyboard edits and resets it after shared clear", async () => {
  await open("board-people-dark");
  await page.locator('.chalk-board[data-ready="true"]').waitFor();
  const undo = page.locator(".chalk-board").getByRole("button", { name: "Undo", exact: true });
  const redo = page.locator(".chalk-board").getByRole("button", { name: "Redo", exact: true });
  expect(await undo.isEnabled()).toBe(false);
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const canvas = page.locator(".excalidraw canvas.interactive");
  await canvas.click({ position: { x: 200, y: 200 } });
  await page.keyboard.press("Meta+a");
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => undo.isEnabled()).toBe(true);
  await undo.click();
  await expect.poll(() => redo.isEnabled()).toBe(true);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page.getByRole("menuitem", { name: "Clear board", exact: true }).click();
  await page.getByText("Board cleared", { exact: true }).waitFor();
  expect(await undo.isEnabled()).toBe(false);
  expect(await redo.isEnabled()).toBe(false);
});
