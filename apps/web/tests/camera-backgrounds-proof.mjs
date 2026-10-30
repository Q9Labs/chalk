import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.CAMERA_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.argv[2];
assert(origin, "Pass the call-state harness origin");
const artifacts = process.env.CAMERA_EFFECTS_PROOF_DIR ?? "/tmp/chalk-camera-backgrounds-proof";
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({
  headless: process.env.CAMERA_EFFECTS_HEADFUL !== "1",
  args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--allow-loopback-in-peer-connection", ...(process.env.CAMERA_EFFECTS_BROWSER_PATH ? [] : ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"])],
  ...(process.env.CAMERA_EFFECTS_BROWSER_PATH ? { executablePath: process.env.CAMERA_EFFECTS_BROWSER_PATH } : {}),
});
const localOnly = process.env.CAMERA_EFFECTS_LOCAL_ONLY === "1";
const measurements = [];
const errors = [];
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.log("Page error:", error.message);
    });
    page.on("console", (message) => console.log("Browser:", message.text()));
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.route("https://assets.chalkmeet.com/ui/backgrounds/**", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1);
      assert(name && /^[a-z0-9.-]+\.(avif|webp)$/.test(name));
      await route.fulfill({ body: await readFile(new URL(`../src/call-states/camera-fixtures/${name}`, import.meta.url)), contentType: name.endsWith(".avif") ? "image/avif" : "image/webp", headers: { "Access-Control-Allow-Origin": "*" } });
    });
    console.log(`Starting ${viewport.width}`);
    await page.goto(`${origin}/camera-backgrounds-proof.html`, { waitUntil: "domcontentloaded", timeout: Number(process.env.CAMERA_EFFECTS_PAGE_TIMEOUT ?? 30_000) });
    await page.waitForFunction(() => customElements.get("chalk-camera-background-fixture"));
    console.log("Mounting camera peers");
    await page.evaluate(
      async ({ localOnly, inputWidth }) => {
        window.cameraBackgroundProof = await document.createElement("chalk-camera-background-fixture").mount({ requireRemote: !localOnly, inputWidth });
      },
      { localOnly, inputWidth: process.env.CAMERA_EFFECTS_BROWSER_PATH ? 1280 : 640 },
    );
    if (!localOnly) await page.waitForFunction(() => document.querySelector('video[aria-label="Remote video"]')?.readyState >= 2);
    console.log("Camera peers connected");
    assert.deepEqual(await page.evaluate(() => window.cameraBackgroundProof.lifecycle()), { disabledCamera: true, privatePreview: true, stoppedPreview: true, resumedCamera: true });
    const initial = await page.evaluate(() => window.cameraBackgroundProof.publication());
    if (!localOnly) assert.equal(initial.state, "connected");
    const pauseForFrames = async () => {
      const start = await page.evaluate((localOnly) => window.cameraBackgroundProof.frames()[localOnly ? "local" : "remote"], localOnly);
      await page.waitForFunction(({ start, localOnly }) => window.cameraBackgroundProof.frames()[localOnly ? "local" : "remote"] >= start + 8, { start, localOnly });
    };
    await pauseForFrames().catch(async (error) => {
      console.log("Frame failure", await page.evaluate(() => ({ publication: window.cameraBackgroundProof.publication(), frames: window.cameraBackgroundProof.frames() })));
      throw error;
    });
    const waitForProcessedPixels = async (background, references) => {
      const frame = await page.waitForFunction(
        ({ background, references, localOnly }) => {
          if (window.cameraBackgroundProof.backgroundState().selected !== background) return false;
          const pixels = window.cameraBackgroundProof.pixels(localOnly);
          const differences = references.map((previous) => {
            let sum = 0;
            for (let i = 0; i < pixels.length; i += 4) if ((i / 4) % 128 < 24) sum += Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2]);
            return sum / (24 * 72 * 3);
          });
          return differences.every((difference) => difference > 12) ? { pixels, differences } : false;
        },
        { background, references, localOnly },
      );
      const decoded = await frame.jsonValue();
      console.log("Decoded processed background", background, decoded.differences);
      return decoded.pixels;
    };
    const original = await page.evaluate((localOnly) => window.cameraBackgroundProof.pixels(localOnly), localOnly);
    await page.screenshot({ path: resolve(artifacts, `none-${viewport.width}.png`) });
    await page.getByRole("button", { name: "Select camera", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Blur", exact: true }).click();
    const blurred = await waitForProcessedPixels("blur", [original]);
    await page.screenshot({ path: resolve(artifacts, `picker-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: resolve(artifacts, `blur-${viewport.width}.png`) });
    await page.getByRole("button", { name: "Select camera", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "Office", exact: true }).click();
    await waitForProcessedPixels("modern-acoustic-office", [original, blurred]);
    await page.getByRole("button", { name: "Select camera", exact: true }).click();
    await page.getByRole("menu").waitFor({ state: "hidden" });
    const cameraGroup = await page.locator(".chalk-shell-split").evaluate((group) => ({
      width: group.getBoundingClientRect().width,
      buttonsWidth: [...group.querySelectorAll("button")].reduce((width, button) => width + button.getBoundingClientRect().width, 0),
      outline: getComputedStyle(group).outlineStyle,
    }));
    assert.equal(cameraGroup.width, cameraGroup.buttonsWidth, "Camera group must fit its buttons");
    assert.equal(cameraGroup.outline, "none", "Pointer dismissal must not show keyboard focus");
    await page.screenshot({ path: resolve(artifacts, `office-${viewport.width}.png`) });
    const publication = await page.evaluate(() => window.cameraBackgroundProof.publication());
    if (!localOnly) assert.deepEqual(publication, initial, "Switching effects must keep the same sender, track, and publication");
    if (!localOnly && viewport.width === 1440 && process.env.CAMERA_EFFECTS_HEADFUL === "1") {
      const beforeHidden = await page.evaluate(async () => (await window.cameraBackgroundProof.stats()).framesDecoded);
      const cover = await context.newPage();
      // Undo Playwright's focus override on its original CDP session. A second
      // session cannot clear this session-scoped override in Chromium.
      await page._connection.toImpl(page).delegate._mainFrameSession._client.send("Emulation.setFocusEmulationEnabled", { enabled: false });
      await cover.bringToFront();
      await page.waitForFunction(() => document.hidden);
      await page.waitForFunction(async (before) => (await window.cameraBackgroundProof.stats()).framesDecoded >= before + 6, beforeHidden, { timeout: 20_000 });
      await cover.close();
      await page.bringToFront();
      await page.waitForFunction(() => !document.hidden);
    }
    // Alternate effects five times; decoded remote frames prove work reached the receiver.
    for (let run = 0; run < (process.env.CAMERA_EFFECTS_MEASURE === "1" ? 5 : 1); run++)
      for (const background of ["none", "blur", "modern-acoustic-office"]) {
        await page.evaluate((background) => window.cameraBackgroundProof.background(background), background);
        await pauseForFrames();
        const sample = await page.evaluate(async () => {
          const start = performance.now();
          const frames = window.cameraBackgroundProof.frames();
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const end = window.cameraBackgroundProof.frames();
          return { seconds: (performance.now() - start) / 1000, localFrames: end.local - frames.local, remoteFrames: end.remote - frames.remote, stats: await window.cameraBackgroundProof.stats() };
        });
        measurements.push({ width: viewport.width, run, background, fps: (localOnly ? sample.localFrames : sample.remoteFrames) / sample.seconds, localFps: sample.localFrames / sample.seconds, ...sample });
        await writeFile(resolve(artifacts, "measurements.json"), JSON.stringify({ measurements, errors }, null, 2));
        assert((localOnly ? sample.localFrames : sample.remoteFrames) > 0, "Remote video must continue advancing");
      }
    assert.equal(await page.evaluate(() => window.cameraBackgroundProof.publication().trackState), "live");
    assert(
      requests.some((url) => url.includes("selfie-segmenter-landscape") && url.startsWith(origin)),
      "Load the model from the app",
    );
    assert(
      requests.some((url) => url.includes("vision_wasm") && url.startsWith(origin)),
      "Load WASM from the app",
    );
    assert(!requests.some((url) => /jsdelivr|unpkg|storage.googleapis/.test(url)), "No third-party runtime model/CDN requests");
    await page.evaluate(() => window.cameraBackgroundProof.dispose());
    await context.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(resolve(artifacts, "measurements.json"), JSON.stringify({ browser: await browser.version(), metric: localOnly ? "local preview frames" : "remote decoded frames", measurements, errors }, null, 2));
  for (const width of [1440, 390])
    for (const background of ["none", "blur", "modern-acoustic-office"]) {
      const fps = measurements
        .filter((entry) => entry.width === width && entry.background === background)
        .map((entry) => entry.fps)
        .sort((a, b) => a - b);
      console.log(`${width} ${background}: median ${fps[Math.floor(fps.length / 2)].toFixed(1)} fps, range ${fps[0].toFixed(1)}–${fps.at(-1).toFixed(1)} (${fps.length} runs)`);
    }
  console.log(`Proof: ${artifacts}`);
} finally {
  await browser.close();
}
