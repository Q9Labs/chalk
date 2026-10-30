import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = await import(process.env.CAMERA_PLAYWRIGHT_MODULE ?? "playwright");
const origin = process.argv[2];
assert(origin, "Pass the call-state harness origin");
const artifacts = process.env.CAMERA_EFFECTS_PROOF_DIR ?? "/tmp/chalk-camera-backgrounds-proof";
await mkdir(artifacts, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(process.env.CAMERA_EFFECTS_BROWSER_PATH ? { executablePath: process.env.CAMERA_EFFECTS_BROWSER_PATH } : { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }) });
const measurements = [];
const errors = [];
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.route("https://assets.chalkmeet.com/ui/backgrounds/**", async (route) => {
      const name = new URL(route.request().url()).pathname.split("/").at(-1);
      assert(name && /^[a-z0-9.-]+\.(avif|webp)$/.test(name));
      await route.fulfill({ body: await readFile(new URL(`../src/call-states/camera-fixtures/${name}`, import.meta.url)), contentType: name.endsWith(".avif") ? "image/avif" : "image/webp", headers: { "Access-Control-Allow-Origin": "*" } });
    });
    await page.goto(`${origin}/call-states.html?state=integration-call`);
    await page.addScriptTag({ type: "module", url: `${origin}/src/call-states/camera-background-fixture.tsx` });
    await page.evaluate(() => customElements.whenDefined("chalk-camera-background-fixture"));
    await page.evaluate(async () => {
      window.cameraBackgroundProof = await document.createElement("chalk-camera-background-fixture").mount();
    });
    await page.waitForFunction(() => document.querySelector('video[aria-label="Remote video"]')?.readyState >= 2);
    const initial = await page.evaluate(() => window.cameraBackgroundProof.publication());
    assert.equal(initial.state, "connected");
    const pauseForFrames = async () => {
      const start = await page.evaluate(() => window.cameraBackgroundProof.frames().remote);
      await page.waitForFunction((start) => window.cameraBackgroundProof.frames().remote >= start + 8, start);
    };
    await pauseForFrames();
    const original = await page.evaluate(() => window.cameraBackgroundProof.pixels());
    await page.screenshot({ path: resolve(artifacts, `none-${viewport.width}.png`) });
    await page.getByRole("button", { name: "Select camera", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Blur", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Blur", exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent?.includes("Loading background"));
    await pauseForFrames();
    await page.screenshot({ path: resolve(artifacts, `picker-${viewport.width}.png`) });
    await page.keyboard.press("Escape");
    await page.screenshot({ path: resolve(artifacts, `blur-${viewport.width}.png`) });
    const blurred = await page.evaluate(() => window.cameraBackgroundProof.pixels());
    const difference = (a, b) => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 4) if ((i / 4) % 128 < 24) sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      return sum / (24 * 72 * 3);
    };
    assert(difference(original, blurred) > 12, "Remote Blur must change background pixels");
    await page.getByRole("button", { name: "Select camera", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name: "Office", exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent?.includes("Loading background"));
    await pauseForFrames();
    await page.keyboard.press("Escape");
    await page.screenshot({ path: resolve(artifacts, `office-${viewport.width}.png`) });
    const replaced = await page.evaluate(() => window.cameraBackgroundProof.pixels());
    assert(difference(blurred, replaced) > 12, "Remote replacement must differ from Blur");
    const publication = await page.evaluate(() => window.cameraBackgroundProof.publication());
    assert.deepEqual(publication, initial, "Switching effects must keep the same sender, track, and publication");
    // Alternate effects five times; decoded remote frames prove work reached the receiver.
    for (let run = 0; run < 5; run++)
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
        measurements.push({ width: viewport.width, run, background, fps: sample.remoteFrames / sample.seconds, localFps: sample.localFrames / sample.seconds, ...sample });
        assert(sample.remoteFrames >= 5, "Remote video must continue advancing");
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
  await writeFile(resolve(artifacts, "measurements.json"), JSON.stringify({ browser: await browser.version(), measurements, errors }, null, 2));
  for (const width of [1440, 390])
    for (const background of ["none", "blur", "modern-acoustic-office"]) {
      const fps = measurements
        .filter((entry) => entry.width === width && entry.background === background)
        .map((entry) => entry.fps)
        .sort((a, b) => a - b);
      console.log(`${width} ${background}: median ${fps[2].toFixed(1)} fps, range ${fps[0].toFixed(1)}–${fps[4].toFixed(1)} (${fps.length} runs)`);
    }
  console.log(`Proof: ${artifacts}`);
} finally {
  await browser.close();
}
