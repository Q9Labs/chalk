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
  });
  await step("the guest has draw access: their stroke reaches the host", async () => {
    await drawStroke(guest.page, { x: 0.6, y: 0.6 }, { x: 0.8, y: 0.7 });
    await bothShow(2, pages);
    for (const person of [host, guest]) await shot(person, "two-strokes");
  });
  await step("the host clears the board for everyone", async () => {
    await host.page.getByRole("button", { name: "Board menu", exact: true }).click();
    await host.page.getByRole("menuitem", { name: "Clear board", exact: true }).click();
    await host.page.getByRole("alertdialog").getByRole("button", { name: "Clear board", exact: true }).click();
    for (const page of pages) await page.locator('.chalk-board[data-elements="0"]').waitFor({ timeout: 30_000 });
    for (const person of [host, guest]) await shot(person, "cleared");
  });
  await step("both leave", async () => {
    for (const who of [host, guest]) {
      await leave(who);
    }
  });
});
