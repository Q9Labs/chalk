import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";

const origin = "http://127.0.0.1:3098";
let server: ChildProcess;
let browser: Browser;
let page: Page;
let deadline: ReturnType<typeof setTimeout>;
const stopServer = () => {
  if (server?.pid && server.exitCode === null) process.kill(-server.pid, "SIGTERM");
};
beforeAll(async () => {
  const occupied = await fetch(origin, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );
  if (occupied) throw new Error(`Stage harness port occupied: ${origin}`);
  server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", "3098", "--strictPort"], { cwd: resolve(import.meta.dirname, "../.."), detached: true, stdio: "ignore" });
  deadline = setTimeout(stopServer, 180_000);
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Stage harness exited ${server.exitCode}`);
    if (
      await fetch(`${origin}/call-states.html`).then(
        (response) => response.ok,
        () => false,
      )
    )
      break;
    await new Promise((done) => setTimeout(done, 200));
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
}, 60_000);
afterAll(async () => {
  await browser?.close();
  clearTimeout(deadline);
  stopServer();
});
async function open(state: string) {
  await page.goto(`${origin}/call-states.html?state=${state}`);
  await page.getByTestId("stage").waitFor();
}

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
  await page.getByRole("button", { name: "Add participant", exact: true }).click();
  expect(await page.locator('[data-stage-item="stage-2"]').getAttribute("data-stage-role")).toBe("primary");
});
it("shows a live local preview and Stop sharing ends it", async () => {
  await open("stage-share-local");
  await page.getByRole("group", { name: "Your share", exact: true }).waitFor();
  expect(await page.getByText("You’re sharing your screen", { exact: true }).isVisible()).toBe(true);
  const preview = page.locator('[data-stage-item="screen-share:stage-0"] video');
  await expect.poll(() => preview.evaluate((video) => video.readyState)).toBeGreaterThanOrEqual(2);
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
