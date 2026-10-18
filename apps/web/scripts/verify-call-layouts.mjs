import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { chromium } from "playwright";

const port = "3072";
const origin = `http://127.0.0.1:${port}`;
const server = spawn("pnpm", ["exec", "vite", "--config", "vite.call-states.config.ts", "--port", port], { cwd: resolve(import.meta.dirname, ".."), stdio: "ignore", detached: true });
let browser;
try {
  browser = await chromium.launch();
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      if ((await fetch(`${origin}/call-states.html`)).ok) break;
    } catch {}
    if (Date.now() > deadline) throw new Error("Harness did not start");
    await new Promise((done) => setTimeout(done, 200));
  }
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    const open = async (state) => {
      await page.goto(`${origin}/call-states.html?state=${state}`);
      await page.getByRole("button", { name: "Layout: Spotlight", exact: true }).waitFor();
    };
    const layout = async (name) => {
      await page.getByRole("button", { name: /^Layout:/ }).click();
      await page.getByRole("menuitemradio").first().waitFor();
      assert.equal(await page.getByRole("menuitemradio").count(), 2);
      await page.getByRole("menuitemradio", { name: new RegExp(`^${name}`) }).click();
      await page.getByRole("menuitemradio").first().waitFor({ state: "hidden" });
      await page.getByRole("button", { name: `Layout: ${name}`, exact: true }).waitFor();
    };
    await open("board");
    await page.locator('[data-testid="stage-primary-content"] .excalidraw canvas').first().waitFor({ timeout: 60_000 });
    await layout("Grid");
    const board = page.getByRole("button", { name: "Whiteboard tile", exact: true });
    await board.locator(".excalidraw canvas").first().waitFor({ timeout: 60_000 });
    await board.click();
    await page.getByRole("button", { name: "Layout: Spotlight", exact: true }).waitFor();
    await page.locator('[data-testid="stage-primary-content"] .excalidraw canvas').first().waitFor({ timeout: 60_000 });
    await layout("Grid");
    const boardToggle = page.getByRole("button", { name: /^(Board|Whiteboard)$/ });
    if ((await boardToggle.count()) === 0) await page.getByRole("button", { name: /More/ }).click();
    await page.getByRole("button", { name: /^(Board|Whiteboard)$/ }).click();
    await board.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Layout: Grid", exact: true }).waitFor();
    if ((await boardToggle.count()) === 0) await page.getByRole("button", { name: /More/ }).click();
    await page.getByRole("button", { name: /^(Board|Whiteboard)$/ }).click();
    await board.waitFor();
    await page.getByRole("button", { name: "Layout: Grid", exact: true }).waitFor();
    await open("share-and-board");
    await page.locator('[data-testid="stage-primary-content"] video').waitFor();
    await page.locator('[aria-label="Whiteboard tile"]').waitFor({ state: "attached" });
    if ((await page.getByRole("button", { name: "Whiteboard tile", exact: true }).count()) === 0)
      await page
        .getByRole("button", { name: /^Go to page / })
        .last()
        .click();
    await page.getByRole("button", { name: "Whiteboard tile", exact: true }).click();
    await page.locator('[data-testid="stage-primary-content"] .excalidraw canvas').first().waitFor({ timeout: 60_000 });
    await open("share-remote");
    await page.locator('[data-testid="stage-primary-content"]').hover();
    assert.equal(await page.getByRole("button", { name: "Stop Sharing", exact: true }).count(), 0);
    await layout("Grid");
    await page.getByRole("button", { name: /Screen share tile/ }).click();
    await page.getByRole("button", { name: "Layout: Spotlight", exact: true }).waitFor();
    await page.locator('[data-testid="stage-primary-content"] video').waitFor();
    console.log(`PASS ${viewport.width}: real board, content selection, persistent layout, menu closure, remote share controls`);
    await page.close();
  }
} finally {
  await browser?.close();
  process.kill(-server.pid, "SIGTERM");
}
