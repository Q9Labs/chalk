import { expect } from "e2e";
import { test } from "@e2e-dev/web";
import { withProofCall } from "../scripts/web-proof/guest.mjs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { mkdir } from "node:fs/promises";

const boardBox = () => {
  const box = document.querySelector(".chalk-board")?.getBoundingClientRect();
  return box ? { x: box.x, y: box.y, width: box.width, height: box.height } : null;
};
const zoomLabel = () => document.querySelector(".chalk-board-zoom-value")?.textContent ?? "";

const stageBoard = '[data-stage-item="whiteboard"]';

function boardPixels() {
  const board = document.querySelector(".chalk-board");
  const canvas = board?.querySelector("canvas");
  if (!board || !(canvas instanceof HTMLCanvasElement)) return null;
  const box = board.getBoundingClientRect();
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The board has no drawing canvas");
  const canvasBox = canvas.getBoundingClientRect();
  const ink = (x: number, y: number, width: number, height: number) => {
    const left = Math.max(0, Math.floor((box.x + box.width * x - canvasBox.x) * devicePixelRatio));
    const top = Math.max(0, Math.floor((box.y + box.height * y - canvasBox.y) * devicePixelRatio));
    const right = Math.min(canvas.width, Math.ceil(left + box.width * width * devicePixelRatio));
    const bottom = Math.min(canvas.height, Math.ceil(top + box.height * height * devicePixelRatio));
    if (right <= left || bottom <= top) return false;
    const pixels = context.getImageData(left, top, right - left, bottom - top).data;
    return pixels.some((value, index) => index % 4 === 3 && value > 32);
  };
  return {
    widthError: Math.abs(canvas.width / devicePixelRatio - box.width),
    heightError: Math.abs(canvas.height / devicePixelRatio - box.height),
    upperLeft: ink(0.14, 0.19, 0.12, 0.08),
    lowerRight: ink(0.71, 0.67, 0.13, 0.09),
    newLowerRight: ink(0.83, 0.83, 0.08, 0.07),
  };
}

function stageSettled() {
  return Array.from(document.querySelectorAll("[data-stage-item]")).every((tile) => tile.getAnimations().every((animation) => animation.playState !== "running" && !animation.pending));
}

async function settleStage(page: Page) {
  await page.locator(`${stageBoard}[data-stage-role="primary"] .chalk-board[data-ready]`).waitFor();
  await page.waitForFunction(stageSettled);
  // Let ResizeObserver delivery and the canvas paint finish without resizing.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function drawStroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const box = await page.evaluate(boardBox);
  if (!box) throw new Error("The board did not open");
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y, { steps: 12 });
  await page.mouse.up();
}

async function trackStageMotion(context: BrowserContext) {
  await context.addInitScript(() => {
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      const frames = [keyframes].flat();
      if (this instanceof HTMLElement && this.hasAttribute("data-stage-item")) {
        if (frames.some((frame) => Object.hasOwn(Object(frame), "transform"))) {
          const html = document.documentElement;
          html.setAttribute(`data-stage-transform-${this.dataset.stageItem}`, "true");
        }
      }
      return animate.call(this, keyframes, options);
    };
  });
}

async function joinBoardParticipants(contexts: BrowserContext[]) {
  const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
  await a.goto(new URL("/space/", process.env.CHALK_PROOF_WEB_URL ?? "http://localhost:3000").href);
  await a.getByLabel("Your name", { exact: true }).fill("BoardA");
  const created = a.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/v1/public/spaces");
  await a.getByRole("button", { name: "Join call", exact: true }).click();
  expect((await created).status()).toBe(201);
  await a.getByRole("button", { name: "Video tile for BoardA", exact: true }).waitFor();
  await expect.poll(() => a.getByRole("button", { name: /^Video tile for / }).count()).toBe(1);
  await a.getByRole("button", { name: "Close call link", exact: true }).click();
  await b.goto(a.url());
  await b.getByLabel("Your name", { exact: true }).fill("BoardB");
  await b.getByRole("button", { name: "Join call", exact: true }).click();
  for (const page of [a, b]) {
    await page.getByRole("button", { name: "Video tile for BoardA", exact: true }).waitFor();
    await page.getByRole("button", { name: "Video tile for BoardB", exact: true }).waitFor();
    await expect.poll(() => page.getByRole("button", { name: /^Video tile for / }).count()).toBe(2);
  }
  return [a, b];
}

async function prepareCornerStrokes(a: Page, b: Page) {
  await a.getByRole("button", { name: "Board", exact: true }).click();
  await Promise.all([a, b].map(settleStage));
  // Following keeps the peer from fitting the first incoming stroke to a different camera.
  await b.getByLabel("Follow BoardA", { exact: true }).click();
  await b.getByText("Following BoardA").waitFor();
  for (const page of [a, b]) await expect.poll(() => page.evaluate(boardPixels)).toMatchObject({ upperLeft: false, lowerRight: false, newLowerRight: false });
  await drawStroke(a, { x: 0.15, y: 0.2 }, { x: 0.24, y: 0.25 });
  await drawStroke(a, { x: 0.72, y: 0.68 }, { x: 0.82, y: 0.74 });
  for (const page of [a, b]) {
    await expect.poll(() => page.locator(".chalk-board").getAttribute("data-elements")).toBe("2");
    await expect.poll(() => page.evaluate(boardPixels)).toMatchObject({ upperLeft: true, lowerRight: true });
  }
  await b.getByRole("button", { name: "Stop", exact: true }).click();
}

async function switchPersonToBoard(a: Page, b: Page) {
  for (const [page, name] of [
    [a, "BoardA"],
    [b, "BoardB"],
  ] satisfies [Page, string][]) {
    await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).click();
    await page.locator(`${stageBoard}[data-stage-role="strip"]`).waitFor();
    await page.waitForFunction(stageSettled);
    await page.locator(stageBoard).click();
    await settleStage(page);
  }
}

async function expectFullBoard(page: Page) {
  await expect
    .poll(
      async () => {
        const pixels = await page.evaluate(boardPixels);
        return pixels ? Math.max(pixels.widthError, pixels.heightError) : Infinity;
      },
      { timeout: 5000 },
    )
    .toBeLessThanOrEqual(2);
  const pixels = await page.evaluate(boardPixels);
  expect(pixels?.upperLeft).toBe(true);
  expect(pixels?.lowerRight).toBe(true);
  const transforms = await page.evaluate(() =>
    Array.from(document.documentElement.attributes)
      .map((attribute) => attribute.name)
      .filter((name) => name.startsWith("data-stage-transform-")),
  );
  expect(transforms.length).toBeGreaterThan(0);
  expect(transforms).not.toContain("data-stage-transform-whiteboard");
}

async function closeBoardParticipants(browser: Browser) {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      await page
        .getByRole("button", { name: "Leave call", exact: true })
        .click({ timeout: 2000 })
        .catch(() => {});
    }
    await context.close();
  }
}

test("the live board keeps its canvas and drawing coordinates after person → board with animations on", async () => {
  const directory = process.env.CHALK_E2E_DIRECTORY ?? ".private/web-proof/board-stage-motion";
  await mkdir(directory, { recursive: true });
  const browser = await chromium.launch();
  try {
    const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: "no-preference", recordVideo: { dir: `${directory}/video`, size: { width: 1440, height: 960 } } })));
    await Promise.all(contexts.map(trackStageMotion));
    const [a, b] = await joinBoardParticipants(contexts);
    await prepareCornerStrokes(a, b);
    await switchPersonToBoard(a, b);
    for (const [index, page] of [a, b].entries()) await page.screenshot({ path: `${directory}/board-stage-return-${index + 1}.png` });
    await expectFullBoard(a);
    await expectFullBoard(b);
    await drawStroke(a, { x: 0.84, y: 0.84 }, { x: 0.9, y: 0.89 });
    for (const [index, page] of [a, b].entries()) {
      await expect.poll(() => page.locator(".chalk-board").getAttribute("data-elements")).toBe("3");
      await expect.poll(async () => (await page.evaluate(boardPixels))?.newLowerRight).toBe(true);
      await page.screenshot({ path: `${directory}/board-stage-drawn-${index + 1}.png` });
    }
  } finally {
    try {
      await closeBoardParticipants(browser);
    } finally {
      await browser.close();
    }
  }
});

// The web app joins by invite, so it can draw but not manage the board. The SDK guest is an
// owner: it opens the board, draws, and brings everyone to its view.
test("the board syncs strokes, sticky notes, follow and bring everyone between two browsers", async ({ app, browser, screen }) => {
  await withProofCall({ app, screen }, async (guest) => {
    await guest.ready;
    await guest.board.open();
    await expect(screen.getByRole("toolbar", "Drawing tools", { exact: true })).toBeVisible();

    // A pen stroke and a sticky note from the web reach the guest.
    const box = await browser.evaluate(boardBox);
    if (!box) throw new Error("The board did not open in the web app");
    await screen.getByRole("button", "Pen", { exact: true }).click();
    await screen.swipe({ from: { x: box.x + box.width * 0.3, y: box.y + box.height * 0.3 }, to: { x: box.x + box.width * 0.5, y: box.y + box.height * 0.4 }, duration: 400 });
    await screen.getByRole("button", "Sticky note", { exact: true }).click();
    await screen.tapAt({ x: box.x + box.width * 0.6, y: box.y + box.height * 0.6 });
    await browser.locator("textarea.excalidraw-wysiwyg").pressSequentially("Ship Friday");
    await browser.locator("textarea.excalidraw-wysiwyg").press("Escape");
    await expect.poll(async () => (await guest.board.elements()).some((element) => element.type === "freedraw"), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await guest.board.elements()).some((element) => element.note), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => (await guest.board.elements()).some((element) => element.text === "Ship Friday"), { timeout: 15_000 }).toBe(true);

    // A stroke from the guest reaches the web board.
    const elementCount = () => Number(document.querySelector(".chalk-board")?.getAttribute("data-elements") ?? 0);
    const before = await browser.evaluate(elementCount);
    await guest.board.draw();
    await expect.poll(() => browser.evaluate(elementCount), { timeout: 15_000 }).toBe(before + 1);

    // Following the guest by its tile moves the web view with the guest's view.
    await screen.getByLabel("Follow Proof").click();
    const following = screen.getByRole("status").filter({ hasText: "Following Proof" });
    await expect(following).toBeVisible();
    expect(await guest.board.view({ x: 0, y: 0, width: 4000, height: 2500, bring: false })).toBe(true);
    await expect.poll(() => browser.evaluate(zoomLabel), { timeout: 15_000 }).not.toBe("100%");
    const wide = await browser.evaluate(zoomLabel);
    expect(await guest.board.view({ x: 100, y: 100, width: 400, height: 250, bring: false })).toBe(true);
    await expect.poll(() => browser.evaluate(zoomLabel), { timeout: 15_000 }).not.toBe(wide);
    await screen.getByRole("button", "Stop", { exact: true }).click();
    await expect(following).not.toBeVisible();

    // Bring everyone makes the web follow the guest again, with a toast that says who did it.
    expect(await guest.board.view({ x: 0, y: 0, width: 2000, height: 1250, bring: true })).toBe(true);
    await expect(screen.getByText("Proof brought everyone to this view")).toBeVisible();
    await expect(following).toBeVisible();
    await app.screenshot("board-web");

    await screen.getByRole("button", "Leave call", { exact: true }).click();
    await guest.leave();
  });
});
