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
  ({ origin, stop } = await startCallHarness(Number(process.env.CHALK_CALL_HARNESS_PORT ?? 0)));
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
      await page.locator("textarea.excalidraw-wysiwyg").fill(text);
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

it("keeps SVG export on our origin when a local font is missing", async () => {
  const context = await browser.newContext();
  const requests: string[] = [];
  const errors: string[] = [];
  const failed: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  context.on("response", (response) => {
    if (response.status() >= 400) failed.push(`${response.status()} ${response.url()}`);
  });
  try {
    await context.route("**/asset-font-probe", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
    await context.route("**/fonts/Virgil/Virgil-Regular.woff2", (route) => route.fulfill({ status: 404, body: "Missing font" }));
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/asset-font-probe`);
    const assetsModule = `/@fs/${resolve(import.meta.dirname, "../../../../packages/whiteboard/src/assets.ts")}`;
    const excalidrawModule = `/@fs/${resolve(import.meta.dirname, "../../../../packages/whiteboard/tests/font-export.fixture.ts")}`;
    await page.addScriptTag({
      type: "module",
      content: `import { configureWhiteboardAssets } from ${JSON.stringify(assetsModule)};
        configureWhiteboardAssets({ excalidrawCssPath: "/chalk-whiteboard/0.18.1/index.css", mathJaxBasePath: "/chalk-mathjax/4.1.3" });
        const { convertToExcalidrawElements, exportToSvg } = await import(${JSON.stringify(excalidrawModule)});
        const svg = await exportToSvg({ elements: convertToExcalidrawElements([{ type: "text", text: "Local font failure", fontFamily: 1, x: 0, y: 0 }]), appState: {}, files: null });
        const output = document.createElement("output");
        output.id = "font-failure-proof";
        output.textContent = svg.outerHTML;
        document.body.append(output);`,
    });
    await page.locator("#font-failure-proof").waitFor({ timeout: 10_000 });
    expect(await page.locator("#font-failure-proof").textContent()).toContain("<svg");
    expect(requests).toContain(`${origin}/chalk-whiteboard/0.18.1/fonts/Virgil/Virgil-Regular.woff2`);
    expect(
      requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin),
      "external font fallback requests",
    ).toEqual([]);
  } finally {
    if (process.env.ASSET_PROOF_DIR) {
      await mkdir(process.env.ASSET_PROOF_DIR, { recursive: true });
      await writeFile(resolve(process.env.ASSET_PROOF_DIR, "font-failure-requests.json"), JSON.stringify({ requests, errors, failed, external: requests.filter((url) => /^https?:/.test(url) && new URL(url).origin !== origin) }, null, 2));
    }
    await context.close();
  }
}, 30_000);

it("loads the embedded renderer entry with local fonts and no CDN requests", async () => {
  const context = await browser.newContext();
  const messages: string[] = [];
  const failures: string[] = [];
  const requests: string[] = [];
  context.on("request", (request) => requests.push(request.url()));
  try {
    await context.addInitScript(`window.ReactNativeWebView = { postMessage: (message) => console.log("native-bridge:" + message) }; document.addEventListener("securitypolicyviolation", (event) => console.error("asset-policy:" + event.blockedURI));`);
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
    const font = await page.evaluate(async () => {
      try {
        const faces = await document.fonts.load("20px Excalifont", "Embedded board text");
        return { faces: faces.map((face) => ({ family: face.family, status: face.status })), error: null };
      } catch (error) {
        return { faces: [], error: String(error) };
      }
    });
    expect(
      requests.filter((request) => /^https?:/.test(request)),
      "embedded external font or CDN requests",
    ).toEqual([]);
    expect(messages.filter((message) => message.startsWith("asset-policy:"))).toEqual([]);
    expect(font.error).toBeNull();
    expect(font.faces.length).toBeGreaterThan(0);
    expect(font.faces.every((face) => face.status === "loaded")).toBe(true);
    expect(requests.some((request) => request.startsWith("file:") && request.includes("/fonts/Excalifont/"))).toBe(true);
    expect(messages.some((message) => message.includes("renderer_load_failed"))).toBe(false);
    expect(failures).toEqual([]);
  } finally {
    if (process.env.ASSET_PROOF_DIR) {
      await mkdir(process.env.ASSET_PROOF_DIR, { recursive: true });
      await writeFile(resolve(process.env.ASSET_PROOF_DIR, "embedded-requests.json"), JSON.stringify({ requests, messages, failures }, null, 2));
    }
    await context.close();
  }
}, 30_000);
