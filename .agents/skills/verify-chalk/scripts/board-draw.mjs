#!/usr/bin/env node
// Drives the "whiteboard" journey with two people: the host opens the board, both draw, both see every stroke, the host clears it.
//
//   node .agents/skills/verify-chalk/scripts/board-draw.mjs <run-id> [--web <origin>]
import { runJourney } from "./journey.mjs";

function stageSettled() {
  return Array.from(document.querySelectorAll("[data-stage-item]")).every((tile) => tile.getAnimations().every((animation) => animation.playState !== "running" && !animation.pending));
}

async function settleStage(page) {
  await page.locator('[data-stage-item="whiteboard"][data-stage-role="primary"] .chalk-board[data-ready]').waitFor({ timeout: 60_000 });
  await page.waitForFunction(stageSettled);
  // Let ResizeObserver delivery and the canvas paint finish before drawing.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// The scene can hold a stroke while the canvas stays blank or mis-sized, so also read the painted pixels.
function readCanvas() {
  const board = document.querySelector(".chalk-board");
  const canvas = board?.querySelector("canvas");
  const context = canvas instanceof HTMLCanvasElement ? canvas.getContext("2d") : null;
  if (!board || !(canvas instanceof HTMLCanvasElement) || !context) return null;
  const box = board.getBoundingClientRect();
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  let ink = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 32) ink += 1;
  return { ink, sizeError: Math.max(Math.abs(canvas.width / devicePixelRatio - box.width), Math.abs(canvas.height / devicePixelRatio - box.height)) };
}

/** Waits until the painted canvas satisfies `accept(ink)` and fills the board; returns the ink count. */
async function paintedInk(page, accept) {
  const deadline = Date.now() + 30_000;
  let last;
  while (Date.now() < deadline) {
    last = await page.evaluate(readCanvas);
    if (last && last.sizeError <= 2 && accept(last.ink)) return last.ink;
    await page.waitForTimeout(250);
  }
  throw new Error(`The board canvas did not paint as expected (last read: ${JSON.stringify(last)})`);
}

async function drawStroke(page, from, to) {
  const box = await page.locator(".chalk-board").boundingBox();
  if (!box) throw new Error("The board did not open");
  // A narrow board keeps its tools in a tray behind the current-tool button.
  if (!(await page.getByRole("button", { name: "Pen", exact: true }).isVisible())) await page.getByRole("button", { name: /^Tools: / }).click();
  await page.getByRole("button", { name: "Pen", exact: true }).click();
  await page.mouse.move(box.x + box.width * from.x, box.y + box.height * from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to.x, box.y + box.height * to.y, { steps: 12 });
  await page.mouse.up();
}

async function bothShow(count, pages) {
  for (const page of pages) await page.locator(`.chalk-board[data-elements="${count}"]`).waitFor({ timeout: 30_000 });
}

await runJourney("board-draw", async ({ step, person, startCall, joinByLink, leave, shot }) => {
  const host = await person("BoardHost", 1);
  const guest = await person("BoardGuest", 2);
  const pages = [host.page, guest.page];
  const inkAfterOne = [];
  let link;

  await step("the host starts a call", async () => {
    ({ link } = await startCall(host));
  });
  await step("the guest joins by the host's link and both see two tiles", async () => {
    await joinByLink(guest, link);
    for (const { page } of [host, guest]) for (const name of [host.name, guest.name]) await page.getByRole("button", { name: `Video tile for ${name}`, exact: true }).waitFor({ timeout: 60_000 });
  });
  await step("the host opens the board and both see it", async () => {
    await host.page.getByRole("region", { name: "Space stage", exact: true }).hover();
    await host.page.getByRole("button", { name: "Board", exact: true }).click();
    await Promise.all(pages.map(settleStage));
    // The guest follows the host's view until they press Stop; drawing coordinates need their own view.
    await guest.page.getByRole("button", { name: "Stop", exact: true }).click();
  });
  await step("the host draws and both see one stroke", async () => {
    await drawStroke(host.page, { x: 0.15, y: 0.2 }, { x: 0.3, y: 0.3 });
    await bothShow(1, pages);
    for (const page of pages) inkAfterOne.push(await paintedInk(page, (ink) => ink > 0));
  });
  await step("the guest has draw access: their stroke reaches the host", async () => {
    await drawStroke(guest.page, { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.7 });
    await bothShow(2, pages);
    for (const [index, page] of pages.entries()) await paintedInk(page, (ink) => ink > inkAfterOne[index]);
    for (const person of [host, guest]) await shot(person, "two-strokes");
  });
  await step("the host clears the board for everyone", async () => {
    await host.page.getByRole("button", { name: "Board menu", exact: true }).click();
    await host.page.getByRole("menuitem", { name: "Clear board", exact: true }).click();
    await host.page.getByRole("alertdialog").getByRole("button", { name: "Clear board", exact: true }).click();
    for (const page of pages) await page.locator('.chalk-board[data-elements="0"]').waitFor({ timeout: 30_000 });
    for (const page of pages) await paintedInk(page, (ink) => ink === 0);
    for (const person of [host, guest]) await shot(person, "cleared");
  });
  await step("both leave", async () => {
    for (const who of [host, guest]) {
      await leave(who);
    }
  });
});
