import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { encodeEmbeddedWhiteboardMessage } from "@q9labsai/chalk-whiteboard/embedded";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startCallHarness } from "./browser-harness";

let origin: string;
let stop: (() => Promise<void>) | undefined;
let browser: Browser;

beforeAll(async () => {
  await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, "../../../../packages/whiteboard/scripts/build-embedded.mjs")]);
  // Each browser suite owns its harness and cleanup independently.
  // fallow-ignore-next-line code-duplication
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
  const pageErrors: string[] = [];
  // Keep the request trace local to the browser context that owns it.
  // fallow-ignore-next-line code-duplication
  let fonts: { family: string; status: string }[] = [];
  context.on("request", (request) => requests.push({ url: request.url(), type: request.resourceType() }));
  context.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
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
      const target = tool === "Sticky note" ? page.locator(".chalk-board-note-layer") : canvas;
      await target.click({ position: { x, y: 320 } });
      await page.locator("textarea.excalidraw-wysiwyg").waitFor();
      await page.keyboard.type(text);
      expect(await page.locator("textarea.excalidraw-wysiwyg").inputValue()).toBe(text);
      if (tool === "Sticky note") await page.keyboard.press("Escape");
    }
    await page.evaluate(() => document.fonts.ready);
    fonts = await page.evaluate(() => Array.from(document.fonts, (font) => ({ family: font.family, status: font.status })));
    if (process.env.ASSET_PROOF_DIR) await page.screenshot({ path: resolve(process.env.ASSET_PROOF_DIR, "board.png") });
    await page.keyboard.press("Escape");
    const mathModule = `/@fs/${resolve(import.meta.dirname, "../../../../packages/whiteboard/src/react/mathjax-renderer.ts")}`;
    const assetsModule = `/@fs/${resolve(import.meta.dirname, "../../../../packages/whiteboard/src/assets.ts")}`;
    await page.addScriptTag({
      type: "module",
      content: `import { renderLatexToSvg } from ${JSON.stringify(mathModule)};
        import { configureWhiteboardAssets, getWhiteboardAssets } from ${JSON.stringify(assetsModule)};
        const paths = getWhiteboardAssets();
        if (paths) configureWhiteboardAssets({ ...paths, mathJaxBasePath: paths.mathJaxBasePath + "/" });
        const output = document.createElement("output");
        output.id = "math-assets-proof";
        output.hidden = true;
        document.body.append(output);
        try {
          const result = await renderLatexToSvg(${JSON.stringify(String.raw`\require{color}\color{blue}{\mathbb{R} + \mathfrak{g} + \sum_{n=1}^{10} n^2}`)});
          output.textContent = result.svg;
        } catch (error) { output.textContent = String(error); }
        output.dataset.complete = "true";`,
    });
    await expect.poll(() => page.locator("#math-assets-proof").getAttribute("data-complete"), { timeout: 30_000 }).toBe("true");
    expect(await page.locator("#math-assets-proof").textContent()).toContain("<svg");
    const external = requests.filter(({ url }) => /^https?:/.test(url) && new URL(url).origin !== origin);
    expect(external, "external HTTP requests").toEqual([]);
    expect(failed).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(fonts.some((font) => /Nunito|Excalifont|Virgil/.test(font.family) && font.status === "loaded")).toBe(true);
    expect(requests.some(({ url }) => url.includes("/chalk-mathjax/"))).toBe(true);
    expect(requests.some(({ url }) => new URL(url).pathname === "/chalk-mathjax/4.1.3/tex-svg.js")).toBe(true);
    expect(requests.some(({ url }) => url.includes("/sre/speech-worker.js"))).toBe(true);
    expect(requests.some(({ url }) => url.includes("/sre/mathmaps/en.json"))).toBe(true);
  } finally {
    if (process.env.ASSET_PROOF_DIR) {
      await writeFile(resolve(process.env.ASSET_PROOF_DIR, "call-requests.json"), JSON.stringify({ requests, failed, pageErrors, fonts, external: requests.filter(({ url }) => /^https?:/.test(url) && new URL(url).origin !== origin) }, null, 2));
    }
    await context.close();
  }
}, 90_000);

it("loads the embedded board from file URLs with adjacent fonts", async () => {
  const context = await browser.newContext();
  const messages: string[] = [];
  const failures: string[] = [];
  try {
    await context.addInitScript(`window.ReactNativeWebView = { postMessage: (message) => console.log("native-bridge:" + message) };`);
    const page = await context.newPage();
    page.on("console", (message) => messages.push(message.text()));
    page.on("pageerror", (error) => failures.push(error.message));
    const url = pathToFileURL(resolve(import.meta.dirname, "../../../../packages/whiteboard/dist/embedded/chalk-whiteboard/index.html"));
    url.searchParams.set("journeyId", "assets-test");
    url.searchParams.set("rendererGeneration", "assets-generation");
    await page.goto(url.href);
    await expect.poll(() => messages.some((message) => message.includes('"type":"ready"'))).toBe(true);
    const initialize = encodeEmbeddedWhiteboardMessage({ type: "initialize", payload: { canDraw: true, canClear: false, theme: "light" } }, { journeyId: "assets-test", rendererGeneration: "assets-generation", nextMessageId: () => "initialize-assets" });
    await page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), initialize);
    await page.locator(".excalidraw canvas.interactive").waitFor();
    await page.evaluate(() => document.fonts.ready);
    expect(messages.some((message) => message.includes("renderer_load_failed"))).toBe(false);
    expect(failures).toEqual([]);
  } finally {
    await context.close();
  }
}, 30_000);
