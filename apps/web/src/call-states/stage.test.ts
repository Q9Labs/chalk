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
  await page.getByText("Board cleared", { exact: true }).waitFor();
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
])("opens a small drawing at full size, centred, in a %sx%s window", async (width, height) => {
  await page.setViewportSize({ width, height });
  try {
    await open("board-small-dark");
    await page.locator('.chalk-board[data-ready="true"]').waitFor();
    await expect.poll(boardZoom, { timeout: 10_000 }).toBe(100);
    // The word "Done" is the only green ink; its painted box sits in the middle of the board.
    const centre = await page.locator(".excalidraw canvas.static").evaluate((element) => {
      if (!(element instanceof HTMLCanvasElement)) throw new Error("Board canvas is missing");
      const context = element.getContext("2d");
      if (!context) throw new Error("Board paint context is missing");
      const { data, width: w, height: h } = context.getImageData(0, 0, element.width, element.height);
      let [left, right, top, bottom] = [w, 0, h, 0];
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const at = (y * w + x) * 4;
          if (Math.abs((data[at] ?? 0) - 40) < 24 && Math.abs((data[at + 1] ?? 0) - 138) < 24 && Math.abs((data[at + 2] ?? 0) - 81) < 24) [left, right, top, bottom] = [Math.min(left, x), Math.max(right, x), Math.min(top, y), Math.max(bottom, y)];
        }
      return { x: (left + right) / 2 / w, y: (top + bottom) / 2 / h };
    });
    expect(centre.x).toBeCloseTo(0.5, 1);
    expect(centre.y).toBeCloseTo(0.5, 1);
  } finally {
    await page.setViewportSize({ width: 1440, height: 900 });
  }
});

it("still zooms out to fit a drawing larger than the board", async () => {
  await page.setViewportSize({ width: 1100, height: 760 });
  try {
    await open("board-people-dark");
    await page.locator('.chalk-board[data-ready="true"]').waitFor();
    await expect.poll(boardZoom, { timeout: 10_000 }).toBeLessThan(100);
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
  await page.getByRole("status").filter({ hasText: "raised a hand" }).waitFor();
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

it.each([
  { width: 640, height: 320, shown: 1 },
  { width: 390, height: 844, shown: 3 },
])("shows the newest device notices that fit between the header and a $width by $height board's open tools", async ({ width, height, shown }) => {
  await page.setViewportSize({ width, height });
  try {
    await open("board-notices-dark");
    await page.getByRole("button", { name: "Drawing tools" }).click();
    await page.locator('.chalk-board-island[data-place="expanded"]').waitFor();
    await expect.poll(() => page.locator(".chalk-toast").count()).toBe(3);
    const header = await page.locator(".chalk-header").evaluate((element) => element.getBoundingClientRect().bottom);
    const toasts = await page.locator(".chalk-toast").evaluateAll((elements) => elements.map((element) => ({ shown: getComputedStyle(element).display !== "none", ...element.getBoundingClientRect().toJSON() })));
    const visible = toasts.filter((toast) => toast.shown);
    expect(visible).toHaveLength(shown);
    expect(toasts.at(-1)?.shown).toBe(true);
    for (const toast of visible) {
      expect(toast.top).toBeGreaterThanOrEqual(header);
      expect(toast.bottom).toBeLessThanOrEqual(height);
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
