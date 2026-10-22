import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";

let origin: string;
let stop: (() => Promise<void>) | undefined;
let browser: Browser;

beforeAll(async () => {
  ({ origin, stop } = await startCallHarness());
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  try {
    await browser?.close();
  } finally {
    await stop?.();
  }
});

it("loads call, board, sticky note, text and math assets from our origin", async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const requests: { url: string; type: string }[] = [];
  const failed: string[] = [];
  context.on("request", (request) => requests.push({ url: request.url(), type: request.resourceType() }));
  context.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  try {
    const page = await context.newPage();
    await page.goto(`${origin}/call-states.html?state=foundation-dark`);
    await page.getByTestId("stage").waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (process.env.ASSET_PROOF_DIR) {
      await mkdir(process.env.ASSET_PROOF_DIR, { recursive: true });
      await page.screenshot({ path: resolve(process.env.ASSET_PROOF_DIR, "call.png") });
    }
    await page.goto(`${origin}/call-states.html?state=board-people-dark`);
    await page.getByRole("button", { name: "Sticky note", exact: true }).waitFor();
    await page.locator(".excalidraw canvas.static").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const canvas = page.locator(".excalidraw canvas.interactive");
    for (const [tool, x, text] of [
      ["Sticky note", 240, "Local sticky note"],
      ["Text", 520, "Local board text"],
    ] as const) {
      await page.getByRole("button", { name: tool, exact: true }).click();
      await canvas.click({ position: { x, y: 320 } });
      await page.keyboard.type(text);
      await page.keyboard.press("Escape");
    }
    const svg = await page.evaluate(
      async (path) => {
        const { renderLatexToSvg } = await import(/* @vite-ignore */ path);
        return (await renderLatexToSvg(String.raw`\require{color}\color{blue}{\mathbb{R} + \mathfrak{g} + \sum_{n=1}^{10} n^2}`)).svg;
      },
      `/@fs/${resolve(import.meta.dirname, "../../../../packages/whiteboard/src/react/mathjax-renderer.ts")}`,
    );
    expect(svg).toContain("<svg");
    await page.evaluate(() => document.fonts.ready);
    const fonts = await page.evaluate(() => Array.from(document.fonts, (font) => ({ family: font.family, status: font.status })));
    const external = requests.filter(({ url }) => /^https?:/.test(url) && new URL(url).origin !== origin);
    if (process.env.ASSET_PROOF_DIR) {
      await page.screenshot({ path: resolve(process.env.ASSET_PROOF_DIR, "board.png") });
      await writeFile(resolve(process.env.ASSET_PROOF_DIR, "call-requests.json"), JSON.stringify({ requests, failed, fonts, external }, null, 2));
    }
    expect(external, "external HTTP requests").toEqual([]);
    expect(failed).toEqual([]);
    expect(fonts.some((font) => /Nunito|Excalifont|Virgil/.test(font.family) && font.status === "loaded")).toBe(true);
    expect(requests.some(({ url }) => url.includes("/chalk-mathjax/"))).toBe(true);
  } finally {
    await context.close();
  }
}, 90_000);
