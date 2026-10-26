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

for (const viewport of [
  { width: 640, height: 320 },
  { width: 390, height: 844 },
]) {
  for (const direction of ["ltr", "rtl"] as const) {
    it(`scrolls and tabs to every overflow share within the call at ${viewport.width}x${viewport.height} ${direction}`, async () => {
      await page.setViewportSize(viewport);
      try {
        await open("stage-shared-overflow");
        await page.locator("[data-part=call-frame]").evaluate((frame, dir) => frame.setAttribute("dir", dir), direction);
        const shares = [page.getByTestId("overflow-share-a"), page.getByTestId("overflow-share-b")];
        const videos = await Promise.all(shares.map((share) => share.locator("video").elementHandle()));
        await page.locator('[data-stage-item="stage:more"]').click();
        const sheet = page.getByRole("dialog");
        await sheet.waitFor();
        const frame = await page.locator("[data-part=call-frame]").boundingBox();
        if (!frame) throw new Error("Missing call frame");
        const insideFrame = async (target: ReturnType<Page["locator"]>) => {
          const box = await target.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.y).toBeGreaterThanOrEqual(frame.y - 1);
          expect(box!.y + box!.height).toBeLessThanOrEqual(frame.y + frame.height + 1);
          expect(box!.x).toBeGreaterThanOrEqual(frame.x - 1);
          expect(box!.x + box!.width).toBeLessThanOrEqual(frame.x + frame.width + 1);
        };
        await insideFrame(sheet);
        for (const share of shares) {
          await share.evaluate((element) => element.scrollIntoView({ block: "center" }));
          await insideFrame(share);
        }
        expect(await sheet.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);

        // The dialog initially focuses the first share; Tab and Shift+Tab must
        // reveal the entire next share without scrolling the surrounding page.
        expect(await shares[0]!.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Tab");
        expect(await shares[1]!.evaluate((element) => element === document.activeElement)).toBe(true);
        await insideFrame(shares[1]!);
        await page.keyboard.press("Shift+Tab");
        expect(await shares[0]!.evaluate((element) => element === document.activeElement)).toBe(true);
        await insideFrame(shares[0]!);
        await page.keyboard.press("Escape");
        await sheet.waitFor({ state: "detached" });
        await page.locator('[data-stage-item="stage:more"]').click();
        await sheet.waitFor();
        for (let index = 0; index < shares.length; index++) {
          expect(await shares[index]!.locator("video").evaluate((video, original) => video === original, videos[index])).toBe(true);
        }
      } finally {
        if (process.env.STAGE_ARTIFACTS) {
          await mkdir(process.env.STAGE_ARTIFACTS, { recursive: true });
          await page.screenshot({ path: resolve(process.env.STAGE_ARTIFACTS, `overflow-${viewport.width}x${viewport.height}-${direction}.png`) });
        }
        await page.setViewportSize({ width: 1440, height: 900 });
      }
    });
  }
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

it.each([390, 650])("floats people over a board on a %ipx-wide screen and keeps toasts above the board's tools", async (width) => {
  await page.setViewportSize({ width, height: 844 });
  await open("board-people-dark");
  await page.locator(".chalk-board-zoom").waitFor();
  const stage = await page.getByTestId("stage").boundingBox();
  const board = await page.locator('[data-stage-role="primary"]').boundingBox();
  expect(board?.height).toBeCloseTo(stage?.height ?? 0, 0);
  const tiles = await page.locator('[data-stage-role="float"]').evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()));
  expect(tiles).toHaveLength(3);
  for (const tile of tiles) expect([tile.width, tile.height, Math.round(tile.right)]).toEqual([76, 44, Math.round((stage?.x ?? 0) + (stage?.width ?? 0) - 12)]);
  // Faces this small keep a short tag with the first name, and the local person comes last.
  expect(
    await page.locator('[data-stage-role="float"] [data-part="tile-tag"]').evaluateAll((tags) =>
      tags
        .map((tag) => [tag.getBoundingClientRect().top, tag instanceof HTMLElement ? tag.innerText.trim() : ""] as const)
        .sort((a, b) => a[0] - b[0])
        .map(([, name]) => name),
    ),
  ).toEqual(["Nora", "Malik", "You"]);
  // On a wide window the tile menu would cover the short tag, so small faces leave it out.
  await page.locator('[data-stage-role="float"]').first().hover();
  expect(await page.locator('[data-stage-role="float"] [data-part="tile-menu"]').evaluateAll((menus) => menus.filter((menu) => getComputedStyle(menu).display !== "none").length)).toBe(0);
  const controlsTop = Math.min(...(await page.locator(".chalk-board-island, .chalk-board-zoom").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))));
  const toastBottom = await page.locator('[data-part="toast-stack"]').evaluate((stack) => stack.getBoundingClientRect().bottom);
  expect(toastBottom).toBeLessThanOrEqual(controlsTop - 8);
  await page.setViewportSize({ width: 1440, height: 900 });
});

it("keeps toasts above a phone board's zoom control while the drawing tools are open", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open("board-people-dark");
  await page.getByRole("button", { name: "Drawing tools" }).click();
  await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
  await page.waitForFunction(() => document.querySelector(".chalk-board-zoom")?.getAnimations().length === 0);
  const controlsTop = Math.min(...(await page.locator(".chalk-board-island, .chalk-board-zoom").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().top))));
  const toastBottom = await page.locator('[data-part="toast-stack"]').evaluate((stack) => stack.getBoundingClientRect().bottom);
  expect(toastBottom).toBeLessThanOrEqual(controlsTop - 8);
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
  await page.locator(".chalk-board-chip").filter({ hasText: "Following Nora" }).waitFor();
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
  await page.locator("[data-part=toast]").getByText("Board cleared", { exact: true }).waitFor();
  await page.locator("[data-part=notice-announcer] [aria-live=polite]").getByText("Board cleared", { exact: true }).waitFor();
  expect(await undo.isEnabled()).toBe(false);
  expect(await redo.isEnabled()).toBe(false);
});

it("drops surface-coloured history before Undo and Redo can restore it", async () => {
  await open("board-people-dark");
  await page.locator('.chalk-board[data-ready="true"]').waitFor();
  const undo = page.locator(".chalk-board").getByRole("button", { name: "Undo", exact: true });
  const redo = page.locator(".chalk-board").getByRole("button", { name: "Redo", exact: true });
  const canvas = page.locator(".excalidraw canvas.interactive");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Board canvas is missing");
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.85, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => undo.isEnabled()).toBe(true);
  await page.getByRole("button", { name: "Board menu", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Paper", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => undo.isEnabled()).toBe(false);
  expect(await redo.isEnabled()).toBe(false);
  await page.locator(".excalidraw").focus();
  await page.keyboard.press("Meta+z");
  await page.keyboard.press("Meta+Shift+z");
  expect(await undo.isEnabled()).toBe(false);
  expect(await redo.isEnabled()).toBe(false);
  const chalkPixels = await page.locator(".excalidraw canvas.static").evaluate((element) => {
    if (!(element instanceof HTMLCanvasElement)) throw new Error("Board canvas is missing");
    const canvas = element;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Board paint context is missing");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] === 241 && pixels[index + 1] === 240 && pixels[index + 2] === 234 && pixels[index + 3] !== 0) count++;
    return count;
  });
  expect(chalkPixels).toBe(0);
});

async function boardZoom() {
  const label = await page.locator(".chalk-board-zoom-value").getAttribute("aria-label");
  return Number(/Zoom (\d+)%/.exec(label ?? "")?.[1]);
}

it.each([
  [1440, 900],
  [1100, 760],
])("opens a small drawing without auto-fit and preserves manual zoom on resize in a %sx%s window", async (width, height) => {
  await page.setViewportSize({ width, height });
  try {
    await open("board-small-dark");
    await page.locator('.chalk-board[data-ready="true"]').waitFor();
    await expect.poll(() => page.locator(".chalk-board").getAttribute("data-elements")).toBe("1");
    await expect.poll(boardZoom).toBe(100);
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(boardZoom).toBe(125);
    await page.setViewportSize({ width: width - 100, height: height - 100 });
    await expect.poll(boardZoom).toBe(125);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it("fits a large drawing only when explicitly requested", async () => {
  await page.setViewportSize({ width: 1100, height: 760 });
  try {
    await open("board-people-dark");
    await page.locator('.chalk-board[data-ready="true"]').waitFor();
    await expect.poll(async () => Number(await page.locator(".chalk-board").getAttribute("data-elements"))).toBeGreaterThan(1);
    await expect.poll(boardZoom).toBe(100);
    await page.getByRole("button", { name: "Fit to content", exact: true }).click();
    await expect.poll(boardZoom).toBeLessThan(100);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it("brings a typed text back for both people after Undo and Redo", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  try {
    const [writer, viewer] = await Promise.all([context.newPage(), context.newPage()]);
    for (const each of [writer, viewer]) {
      await each.goto(`${origin}/call-states.html?state=board-relay-dark`, { waitUntil: "domcontentloaded" });
      await each.locator('.chalk-board[data-ready="true"]').waitFor({ timeout: 20_000 });
    }
    // Ink is every painted pixel that stands out from the board's own colour.
    const ink = (each: Page) =>
      each.locator(".excalidraw canvas.static").evaluate((element) => {
        if (!(element instanceof HTMLCanvasElement)) throw new Error("Board canvas is missing");
        const context = element.getContext("2d");
        if (!context) throw new Error("Board paint context is missing");
        const { data } = context.getImageData(0, 0, element.width, element.height);
        let count = 0;
        for (let at = 0; at < data.length; at += 4) if (Math.abs((data[at] ?? 0) - (data[0] ?? 0)) + Math.abs((data[at + 1] ?? 0) - (data[1] ?? 0)) + Math.abs((data[at + 2] ?? 0) - (data[2] ?? 0)) > 120) count++;
        return count;
      });
    const blank = (await ink(viewer)) + 50;
    await writer.getByRole("button", { name: "Text", exact: true }).click();
    await writer.locator(".excalidraw canvas.interactive").click();
    await writer.keyboard.type("Shared note");
    await writer.keyboard.press("Escape");
    await expect.poll(() => ink(viewer), { timeout: 10_000 }).toBeGreaterThan(blank);

    await writer.getByRole("button", { name: "Undo", exact: true }).click();
    await expect.poll(() => ink(viewer), { timeout: 10_000 }).toBeLessThan(blank);
    // Undo leaves the text empty but on the board. A viewer that deletes it holds a copy as new as the writer's Redo,
    // so whether Redo reaches them turns on a random tie-break.
    await viewer.waitForTimeout(1_000);
    expect(await viewer.locator(".chalk-board").getAttribute("data-elements")).toBe("1");
    await writer.getByRole("button", { name: "Redo", exact: true }).click({ timeout: 5_000 });
    await expect.poll(() => ink(writer), { timeout: 10_000 }).toBeGreaterThan(blank);
    await expect.poll(() => ink(viewer), { timeout: 10_000 }).toBeGreaterThan(blank);
  } finally {
    await context.close();
  }
});

it("lowers your hand while another person's raised-hand toast is showing", async () => {
  await open("hand-peer-toast");
  await page.getByRole("button", { name: "Reactions", exact: true }).click();
  await page.locator("[data-part=toast]").filter({ hasText: "raised a hand" }).waitFor();
  const hand = page.getByRole("button", { name: "Raise hand", exact: true });
  expect(await hand.getAttribute("aria-pressed")).toBe("true");
  // A real click: Playwright waits while another element, such as a toast, would take the pointer.
  await hand.click({ timeout: 2_000 });
  await expect.poll(() => hand.getAttribute("aria-pressed")).toBe("false");
});

it("keeps a live share selectable when a phone guest pins the board", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await open("stage-board-share");
    await page.locator('[data-stage-item="whiteboard"]').click();
    await page.locator(".chalk-board[data-primary]").waitFor();
    const share = page.locator('[data-stage-item="screen-share:stage-1"]');
    expect(await share.isVisible()).toBe(true);
    await share.click();
    await expect.poll(() => share.getAttribute("data-stage-role")).toBe("primary");
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

// Full windows, calls embedded in taller host pages, and a short and narrow call in a taller and wider page. The header still picks its phone layout from the window, so the wider page stays phone-sized.
const noticeCalls = [
  ...[
    { width: 640, height: 320 },
    { width: 374, height: 320 },
    { width: 568, height: 320 },
    { width: 844, height: 390 },
    { width: 390, height: 844 },
    // The shortest call that still stacks notices, at a phone's width, where they wrap the most.
    { width: 390, height: 620 },
  ].map(({ width, height }) => ({ name: `${width}x${height}`, width, height, embed: "" })),
  ...[390, 640, 844].map((width) => ({ name: `${width}x320 embed`, width, height: 844, embed: "320" })),
  { name: "300x320 embed in 600x760", width: 600, height: 760, embed: "300x320" },
];
const LONG_CALL_NAME = "Year 11 chemistry revision for the whole of 11B with Ms Rahman, Mr Okafor, the lab technicians and every parent who asked to listen in";
// Device errors, an error carrying a long link and error token, and joins from people with long unbroken names. The new content and the narrow call also carry a long call name.
const noticeContents = [
  { kind: "device", notices: 1 },
  { kind: "device", notices: 3 },
  { kind: "token", notices: 1 },
  { kind: "join", notices: 2 },
];
const noticeCases = noticeCalls.flatMap((call) =>
  (["dark", "light"] as const).flatMap((scheme) => [false, true].flatMap((tools) => [false, true].flatMap((tray) => noticeContents.map((content) => ({ ...call, ...content, scheme, tools, tray, callName: content.kind !== "device" || call.embed === "300x320" ? LONG_CALL_NAME : "" }))))),
);

function noticeState(scheme: string, { kind, notices, embed, callName, raise = "" }: { readonly kind: string; readonly notices: number; readonly embed: string; readonly callName: string; readonly raise?: string }) {
  const params = new URLSearchParams({ notices: String(notices), kind });
  if (raise) params.set("raise", raise);
  if (embed) params.set("embed", embed);
  if (callName) params.set("name", callName);
  return `board-notices-${scheme}&${params}`;
}

/** Notices shown on the stage plus those the header's notice button holds. */
function noticeCount() {
  return page.evaluate(() => {
    const shown = document.querySelectorAll("[data-part='toast-stack'] [data-part='toast']").length;
    const label = document.querySelector("[data-part='notice-button']")?.getAttribute("aria-label") ?? "";
    return shown + Number(/Show (\d+) notice/.exec(label)?.[1] ?? 0);
  });
}

it("folds an expired offline warning into Notices with the board tools open", async () => {
  await page.setViewportSize({ width: 640, height: 320 });
  try {
    await page.goto(`${origin}/call-states.html?state=offline-notice`);
    await page.getByRole("button", { name: "Drawing tools", exact: true }).click();
    await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
    if (process.env.STAGE_ARTIFACTS) {
      await mkdir(process.env.STAGE_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: resolve(process.env.STAGE_ARTIFACTS, "offline-warning.png") });
    }
    expect(await page.locator("[data-part='toast']").count()).toBe(0);
    const notices = page.getByRole("button", { name: "Show 2 notices", exact: true });
    await notices.click();
    const warning = page.locator("[data-part='notice']").filter({ hasText: "Your expired offline actions were not sent." });
    await expect.poll(() => warning.count()).toBe(1);
    expect(await page.locator("[data-part='notice']").count()).toBe(2);
    await warning.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect.poll(() => warning.count()).toBe(0);
    await expect.poll(() => page.getByRole("button", { name: "Show 1 notice", exact: true }).count()).toBe(1);
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator("[data-part='toast']").count()).toBe(1);
    await page.setViewportSize({ width: 640, height: 320 });
    await expect.poll(() => page.locator("[data-part='toast']").count()).toBe(0);
    await expect.poll(noticeCount).toBe(1);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it.each([false, true])("fits SDK notices to a tall call's actual band, long=%s", async (long) => {
  await page.setViewportSize({ width: 390, height: 620 });
  try {
    await page.goto(`${origin}/call-states.html?state=notice-band${long ? "&long=1" : ""}`);
    await page.getByRole("button", { name: "Drawing tools", exact: true }).click();
    await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
    await expect.poll(noticeCount).toBe(long ? 1 : 10);
    await page.waitForFunction(() => [...document.querySelectorAll("[data-part='toast']")].every((toast) => toast.getAnimations().every((animation) => animation.playState !== "running")));
    if (process.env.STAGE_ARTIFACTS) {
      await mkdir(process.env.STAGE_ARTIFACTS, { recursive: true });
      await page.screenshot({ path: resolve(process.env.STAGE_ARTIFACTS, `notice-band-${long ? "long" : "ten"}.png`) });
    }
    const outside = await page.locator("[data-part='toast-stack']").evaluate((stack) => {
      const band = stack.getBoundingClientRect();
      const style = getComputedStyle(stack);
      const top = band.top + parseFloat(style.paddingTop);
      const bottom = band.bottom - parseFloat(style.paddingBottom);
      return [...stack.children]
        .filter((toast) => {
          const box = toast.getBoundingClientRect();
          return box.top < top - 0.5 || box.bottom > bottom + 0.5 || toast.scrollHeight > toast.clientHeight + 1;
        })
        .map((toast) => toast.textContent);
    });
    expect(outside).toEqual([]);
    const button = page.locator("[data-part='notice-button']");
    await button.click();
    await expect.poll(() => page.locator("[data-part='notice']").count()).toBeGreaterThan(0);
    expect(await noticeCount()).toBe(long ? 1 : 10);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it.each(noticeCases)("shows notices whole and off every control: $name, $scheme, tools open $tools, reactions open $tray, $notices $kind notices", async ({ width, height, scheme, tools, tray, ...content }) => {
  await page.setViewportSize({ width, height });
  try {
    await open(noticeState(scheme, content));
    await page.locator(".chalk-board[data-primary] .chalk-board-zoom").waitFor();
    await expect.poll(noticeCount).toBe(content.notices);
    if (tools) {
      await page.getByRole("button", { name: "Drawing tools", exact: true }).click();
      await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
    }
    if (tray) {
      await page.getByRole("button", { name: "Reactions", exact: true }).click();
      await page.locator(".chalk-shell-reactions").waitFor();
    }
    await page.waitForFunction(() => [...document.querySelectorAll(".chalk-board-zoom, [data-part='toast'], .chalk-shell-reactions")].every((element) => element.getAnimations().every((animation) => animation.playState !== "running")));
    expect(await noticeCount()).toBe(content.notices);
    const problems = await page.evaluate(() => {
      const found: string[] = [];
      const frame = document.querySelector("[data-part='call-frame']")?.getBoundingClientRect();
      if (!frame) return ["no call frame"];
      // A control counts only where it can be seen: inside the window, the call, and the board or toolbar that clips it.
      const visible = (element: Element) => {
        let box = { left: Math.max(0, frame.left), right: Math.min(innerWidth, frame.right), top: Math.max(0, frame.top), bottom: Math.min(innerHeight, frame.bottom) };
        for (const clip of [element, element.closest(".chalk-board-island"), element.closest(".chalk-board")]) {
          if (!clip) continue;
          const rect = clip.getBoundingClientRect();
          box = { left: Math.max(box.left, rect.left), right: Math.min(box.right, rect.right), top: Math.max(box.top, rect.top), bottom: Math.min(box.bottom, rect.bottom) };
        }
        return box;
      };
      const name = (control: Element) => control.getAttribute("aria-label") ?? control.textContent?.trim();
      const controls = document.querySelectorAll(".chalk-frame-header :is(button, a), .chalk-board[data-primary] :is(.chalk-board-zoom button, .chalk-board-island button, .chalk-board-menu-button), .chalk-shell-reactions button, [data-part='dock'] button");
      for (const control of controls) {
        const box = visible(control);
        if (box.right - box.left < 1 || box.bottom - box.top < 1 || getComputedStyle(control).visibility === "hidden") continue;
        for (const at of [0.15, 0.5, 0.85]) {
          const target = document.elementFromPoint(box.left + (box.right - box.left) * at, (box.top + box.bottom) / 2);
          if (target?.closest("[data-part='toast']")) found.push(`a notice takes ${name(control)}'s click at ${Math.round(at * 100)}%`);
        }
      }
      // The header's controls and timer stay apart and inside the call, however long the call's name.
      const header = [...document.querySelectorAll(".chalk-frame-header :is(button, a, [data-part='call-timer'])")].filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
      for (const [index, a] of header.entries()) {
        const box = a.getBoundingClientRect();
        if (box.left < frame.left - 0.5 || box.right > frame.right + 0.5) found.push(`${name(a)} leaves the call's header`);
        for (const b of header.slice(index + 1)) {
          if (a.contains(b) || b.contains(a)) continue;
          const other = b.getBoundingClientRect();
          if (box.left < other.right - 0.5 && other.left < box.right - 0.5 && box.top < other.bottom - 0.5 && other.top < box.bottom - 0.5) found.push(`${name(a)} overlaps ${name(b)} in the header`);
        }
      }
      const shown = [...document.querySelectorAll<HTMLElement>("[data-part='toast-stack'] [data-part='toast']")];
      for (const toast of shown) {
        const box = toast.getBoundingClientRect();
        const text = toast.querySelector<HTMLElement>(":scope > span");
        if (box.height < 47.5) found.push(`a notice is ${box.height}px tall`);
        if (box.top < frame.top - 0.5 || box.bottom > frame.bottom + 0.5 || box.left < frame.left - 0.5 || box.right > frame.right + 0.5) found.push("a notice leaves the call");
        if (text && (text.scrollHeight > text.clientHeight + 1 || text.scrollWidth > text.clientWidth + 1 || getComputedStyle(text).textOverflow === "ellipsis")) found.push("a notice cuts its message");
        if (toast.scrollWidth > toast.clientWidth + 1) found.push("a notice's text or controls spill out of it");
        for (const part of toast.children) {
          const inner = part.getBoundingClientRect();
          if (inner.left < box.left - 0.5 || inner.right > box.right + 0.5) found.push("a notice's text or controls spill out of it");
        }
      }
      const button = document.querySelector("[data-part='notice-button']");
      const place = button?.getBoundingClientRect();
      const reachable = Boolean(button && place && place.width > 0 && button.contains(document.elementFromPoint(place.left + place.width / 2, place.top + place.height / 2)));
      if (button && !reachable) found.push("the header's notice button can't be clicked");
      if (shown.length === 0 && !button) found.push("no notice shows and the header has no notice button");
      return [...new Set(found)];
    });
    expect(problems).toEqual([]);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it.each([
  { name: "390x320 embed", width: 390, height: 844, embed: "320" },
  { name: "300x320 embed in 600x760", width: 600, height: 760, embed: "300x320" },
])(
  "reaches every notice by keyboard, never a hidden control, in a $name call with eight notices",
  async ({ width, height, embed }) => {
    await page.setViewportSize({ width, height });
    try {
      await open(noticeState("dark", { kind: "device", notices: 8, embed, callName: "" }));
      await page.locator(".chalk-board[data-primary] .chalk-board-zoom").waitFor();
      await page.getByRole("button", { name: "Drawing tools", exact: true }).click();
      await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
      await expect.poll(noticeCount).toBe(8);
      // A stop counts as seen when it is visible inside the host's box for the call. A notice's own controls must also be uncovered at their centre.
      const stop = () =>
        page.evaluate(() => {
          const active = document.activeElement;
          const call = document.querySelector("main")?.getBoundingClientRect();
          if (!(active instanceof HTMLElement) || active === document.body || !call) return { name: "", hidden: false, notices: false };
          const box = active.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const notice = Boolean(active.closest("[data-part='notice-button'], .chalk-notice-list, [data-part='toast']"));
          const seen = active.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && box.width > 1 && x >= call.left && x <= call.right && y >= call.top && y <= call.bottom && (!notice || active.contains(document.elementFromPoint(x, y)));
          return { name: active.getAttribute("aria-label") ?? active.textContent?.trim() ?? "", hidden: !seen, notices: active.dataset.part === "notice-button" };
        });
      const stops = await page.locator("main :is(button, a[href], [tabindex]:not([tabindex='-1']))").count();
      const hidden: string[] = [];
      let reachedButton = false;
      for (let step = 0; step < stops + 2; step += 1) {
        await page.keyboard.press("Tab");
        const at = await stop();
        if (at.hidden) hidden.push(at.name);
        reachedButton ||= at.notices;
      }
      expect(hidden).toEqual([]);
      expect(reachedButton).toBe(true);
      const button = page.locator("[data-part='notice-button']");
      const folded = Number(/Show (\d+) notice/.exec((await button.getAttribute("aria-label")) ?? "")?.[1] ?? 0);
      await button.focus();
      await page.keyboard.press("Enter");
      const list = page.getByRole("dialog", { name: "Notices" });
      await expect.poll(() => list.locator("[data-part='notice']").count()).toBe(folded);
      const inside = await list.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const call = document.querySelector("main")?.getBoundingClientRect();
        return Boolean(call && box.left >= call.left - 0.5 && box.right <= call.right + 0.5 && box.top >= call.top - 0.5 && box.bottom <= call.bottom + 0.5);
      });
      expect(inside).toBe(true);
      const messages = await list.locator("[data-part='notice'] > span").evaluateAll((spans) => spans.map((span) => span.scrollHeight <= span.clientHeight + 1 && span.scrollWidth <= span.clientWidth + 1));
      expect(messages.every(Boolean)).toBe(true);
      // Tab through the list's controls until focus leaves it, which closes it.
      // Opening the list focuses its first control, which counts as the first stop.
      let inList = 0;
      let left = false;
      for (let step = 0; step < folded * 2 + 2; step += 1) {
        if (step > 0) await page.keyboard.press("Tab");
        if (!(await page.evaluate(() => Boolean(document.activeElement?.closest(".chalk-notice-list"))))) {
          left = step > 0;
          if (left) break;
          continue;
        }
        inList += 1;
        const at = await stop();
        if (at.hidden) hidden.push(at.name);
      }
      expect(hidden).toEqual([]);
      expect(inList).toBeGreaterThanOrEqual(folded);
      if (left) {
        await list.waitFor({ state: "hidden" });
        await button.focus();
        await page.keyboard.press("Enter");
      }
      await list.getByRole("button", { name: "Dismiss" }).last().click();
      await expect.poll(() => list.locator("[data-part='notice']").count()).toBe(folded - 1);
    } finally {
      await page.setViewportSize({ width: 1440, height: 900 });
    }
  },
  90_000,
);

it("keeps a join notice while it has no room, then lets it time out once it shows", async () => {
  await page.setViewportSize({ width: 640, height: 320 });
  try {
    await open(noticeState("dark", { kind: "join", notices: 1, embed: "", callName: "", raise: "event" }));
    await page.locator(".chalk-board[data-primary] .chalk-board-zoom").waitFor();
    await page.getByRole("button", { name: "Drawing tools", exact: true }).click();
    await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
    // The join arrives only once the tools are open, so it never shows before it waits.
    await page.locator("html[data-notices-ready]").waitFor({ state: "attached" });
    await page.evaluate(() => document.dispatchEvent(new Event("raise-notices")));
    const button = page.getByRole("button", { name: "Show 1 notice" });
    await button.waitFor();
    // Longer than a join notice's five seconds on the stage.
    await page.waitForTimeout(6_500);
    expect(await button.count()).toBe(1);
    await page.setViewportSize({ width: 390, height: 844 });
    const toast = page.locator("[data-part='toast-stack'] [data-part='toast']");
    await toast.waitFor();
    expect(await button.count()).toBe(0);
    await page.waitForTimeout(4_000);
    expect(await toast.count()).toBe(1);
    await expect.poll(() => toast.count(), { timeout: 3_000 }).toBe(0);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it("keeps both live shares reachable beside a short board whose faces can't float", async () => {
  await page.setViewportSize({ width: 624, height: 320 });
  try {
    await open("board-shares-dark");
    const board = page.locator('[data-stage-item="whiteboard"]');
    if ((await board.getAttribute("data-stage-role")) !== "primary") await board.click();
    await expect.poll(() => board.getAttribute("data-stage-role")).toBe("primary");
    const stage = await page.getByTestId("stage").boundingBox();
    expect([Math.round(stage?.width ?? 0), Math.round(stage?.height ?? 0)]).toEqual([608, 162]);
    const shares = page.locator('[data-stage-item^="screen-share:"]');
    await expect.poll(() => shares.count()).toBe(2);
    for (const id of await shares.evaluateAll((elements) => elements.map((element) => element.getAttribute("data-stage-item")))) {
      const share = page.locator(`[data-stage-item="${id}"]`);
      expect(await share.getAttribute("aria-hidden"), id ?? "").not.toBe("true");
      await share.click();
      await expect.poll(() => share.getAttribute("data-stage-role")).toBe("primary");
      await board.click();
      await expect.poll(() => board.getAttribute("data-stage-role")).toBe("primary");
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it("keeps a share beside a short board from covering the zoom control, with the drawing tools closed or open", async () => {
  await page.setViewportSize({ width: 640, height: 320 });
  try {
    await open("board-share-dark");
    if (!(await page.locator(".chalk-board[data-primary]").count())) await page.locator('[data-stage-item="whiteboard"]').click();
    await page.locator(".chalk-board[data-primary]").waitFor();
    const zoomHit = () =>
      page.locator(".chalk-board-zoom").evaluate(async (zoom) => {
        await Promise.all(zoom.getAnimations().map((animation) => animation.finished));
        const rect = zoom.getBoundingClientRect();
        return [0.15, 0.5, 0.85].every((at) => zoom.contains(document.elementFromPoint(rect.left + rect.width * at, rect.top + rect.height / 2)));
      });
    expect(await zoomHit()).toBe(true);
    await page.getByRole("button", { name: "Drawing tools" }).click();
    await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
    expect(await zoomHit()).toBe(true);
    const stage = await page.getByTestId("stage").evaluate((element) => element.getBoundingClientRect().toJSON());
    for (const tile of await page.locator("[data-stage-role]").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().toJSON()))) {
      expect(tile.left).toBeGreaterThanOrEqual(stage.left - 0.5);
      expect(tile.right).toBeLessThanOrEqual(stage.right + 0.5);
      expect(tile.top).toBeGreaterThanOrEqual(stage.top - 0.5);
      expect(tile.bottom).toBeLessThanOrEqual(stage.bottom + 0.5);
    }
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it("keeps a weak-connection badge off the short tag on a small face", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  try {
    await open("stage-board-weak");
    const board = page.locator('[data-stage-item="whiteboard"]');
    if ((await board.getAttribute("data-stage-role")) !== "primary") await board.click();
    await expect.poll(() => board.getAttribute("data-stage-role")).toBe("primary");
    const face = page.locator('[data-stage-role="float"]', { has: page.locator('[data-part="tile-signal"]') });
    const badge = await face.locator('[data-part="tile-signal"]').boundingBox();
    const tag = await face.locator('[data-part="tile-tag"]').boundingBox();
    const tile = await face.boundingBox();
    expect(tile?.height).toBe(44);
    expect((badge?.y ?? 0) + (badge?.height ?? 0)).toBeLessThanOrEqual(tag?.y ?? 0);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it("reflows a folded notice into a wider band and back without clipping", async () => {
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await open("notice-band&fitWidth=1");
    await page.evaluate(() => document.fonts.ready);
    await page.locator("[data-part=toast]").waitFor();
    const toastHeight = () => page.locator("[data-part=toast]").evaluate((toast) => toast.getBoundingClientRect().height);
    const narrowHeight = await toastHeight();
    await page.setViewportSize({ width: 900, height: 844 });
    await expect.poll(toastHeight).toBeLessThan(narrowHeight);
    const wideHeight = await toastHeight();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(toastHeight).toBe(narrowHeight);
    const bandHeight = (narrowHeight + wideHeight) / 2;
    await page.addStyleTag({ content: `.chalk-toasts { height: ${bandHeight}px; top: auto; padding-bottom: 0; }` });
    await expect.poll(() => page.locator("[data-part=toast]").count()).toBe(0);
    await page.getByRole("button", { name: "Show 1 notice", exact: true }).waitFor();
    await page.setViewportSize({ width: 900, height: 844 });
    await expect.poll(() => page.locator("[data-part=toast]").count()).toBe(1);
    const fits = await page.locator("[data-part=toast]").evaluate((toast) => {
      const band = toast.parentElement?.getBoundingClientRect();
      const box = toast.getBoundingClientRect();
      return Boolean(band && box.top >= band.top && box.bottom <= band.bottom && box.left >= band.left && box.right <= band.right);
    });
    expect(fits).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(() => page.locator("[data-part=toast]").count()).toBe(0);
    await page.getByRole("button", { name: "Show 1 notice", exact: true }).waitFor();
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});
