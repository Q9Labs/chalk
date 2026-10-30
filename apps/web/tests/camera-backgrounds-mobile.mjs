import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const origin = process.argv[2];
assert(origin, "Pass the call-state harness origin");
const directory = resolve(process.env.CAMERA_EFFECTS_PROOF_DIR ?? "/tmp/chalk-camera-mobile-proof");
await mkdir(directory, { recursive: true });
const report = { browsers: [], throttle: null };
const save = () => writeFile(resolve(directory, "mobile-proof.json"), JSON.stringify(report, null, 2));
const install = async (page) => {
  await page.route("https://assets.chalkmeet.com/ui/backgrounds/**", async (route) => {
    const name = new URL(route.request().url()).pathname.split("/").at(-1);
    assert(name && /^[a-z0-9.-]+\.(avif|webp)$/.test(name));
    await route.fulfill({ body: await readFile(new URL(`../src/call-states/camera-fixtures/${name}`, import.meta.url)), contentType: name.endsWith(".avif") ? "image/avif" : "image/webp", headers: { "Access-Control-Allow-Origin": "*" } });
  });
};
const runtimeAsset = (url) => /mediapipe|vision_wasm|selfie-segmenter/.test(url);
const mount = async (page, options) => {
  await page.goto(`${origin}/camera-backgrounds-proof.html`);
  await page.waitForFunction(() => customElements.get("chalk-camera-background-fixture"));
  await page.evaluate(async (options) => {
    window.cameraBackgroundProof = await document.createElement("chalk-camera-background-fixture").mount(options);
  }, options);
};
const advance = async (page) => {
  const time = await page.locator('video[aria-label="Local video"]').evaluate((video) => video.currentTime);
  await page.waitForFunction((before) => document.querySelector('video[aria-label="Local video"]').currentTime > before + 0.2, time);
};

for (const engine of [webkit, firefox]) {
  const browser = await engine.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  try {
    await install(page);
    await mount(page, { requireRemote: false, inputWidth: 640 });
    await advance(page);
    const source = await page.evaluate(() => window.cameraBackgroundProof.source());
    await page.getByRole("button", { name: "Select camera", exact: true }).click();
    const supported = !source.sameTrack;
    const effects = [];
    if (supported) {
      for (const [label, id] of [
        ["Blur", "blur"],
        ["Office", "modern-acoustic-office"],
      ]) {
        await page.getByRole("menuitemradio", { name: label, exact: true }).click();
        await page.waitForFunction((id) => window.cameraBackgroundProof.backgroundState().selected === id, id);
        await advance(page);
        effects.push(id);
      }
    } else {
      assert.equal(await page.getByText("Background", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("menuitemradio", { name: "Blur", exact: true }).count(), 0);
      assert.equal(await page.getByRole("menuitemradio", { name: "Office", exact: true }).count(), 0);
      assert(!requests.some(runtimeAsset), "Unsupported browsers must not load effect assets");
    }
    await advance(page);
    assert.equal((await page.evaluate(() => window.cameraBackgroundProof.source())).live, true);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: resolve(directory, `${engine.name()}-phone.png`) });
    report.browsers.push({ engine: engine.name(), version: browser.version(), supported, effects, backgroundHidden: !supported, cameraAdvances: true, cameraLive: true, errors });
    await save();
  } finally {
    await page.evaluate(() => window.cameraBackgroundProof?.dispose()).catch(() => {});
    await browser.close();
  }
}

assert(process.env.CAMERA_EFFECTS_FAKE_CAMERA, "Provide a native Y4M fake-camera file for the throttle proof");
const rate = Number(process.env.CAMERA_EFFECTS_THROTTLE ?? 8);
const browser = await chromium.launch({
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${process.env.CAMERA_EFFECTS_FAKE_CAMERA}`,
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--disable-features=WebRtcHideLocalIpsWithMdns",
    "--allow-loopback-in-peer-connection",
  ],
});
try {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const page = await context.newPage();
  const requests = [];
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => requests.push(request.url()));
  await install(page);
  await mount(page, { requireRemote: true, nativeCamera: true });
  await advance(page);
  const initialEffectRequests = requests.filter(runtimeAsset);
  assert.equal(initialEffectRequests.length, 0, "Joining with None must not load MediaPipe, its model, or WASM");
  const initial = await page.evaluate(() => window.cameraBackgroundProof.publication());
  const camera = page.getByRole("button", { name: "Select camera", exact: true });
  await camera.click();
  assert.equal(await camera.evaluate((button) => button.matches(":focus-visible")), false);
  assert.equal(await camera.evaluate((button) => getComputedStyle(button.closest(".chalk-shell-split")).outlineStyle), "none");
  await page.keyboard.press("Escape");
  await camera.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.waitForFunction(() => {
    const button = document.querySelector('button[aria-label="Select camera"]');
    return button.matches(":focus-visible") && getComputedStyle(button).outlineWidth === "0px" && getComputedStyle(button.closest(".chalk-shell-split")).outlineWidth === "2px";
  });
  const ring = await camera.evaluate((button) => ({ child: getComputedStyle(button).outlineWidth, parent: getComputedStyle(button.closest(".chalk-shell-split")).outlineWidth, radius: getComputedStyle(button.closest(".chalk-shell-split")).borderRadius }));
  assert.equal(ring.child, "0px");
  assert.equal(ring.parent, "2px");
  assert.equal(ring.radius, "999px");
  await page.screenshot({ path: resolve(directory, "keyboard-focus-phone.png") });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  const started = performance.now();
  await camera.click();
  await page.getByRole("menuitemradio", { name: "Blur", exact: true }).click();
  await page.waitForFunction(() => window.cameraBackgroundProof.backgroundState().fallbackFps !== undefined, undefined, { timeout: 90_000 });
  const elapsedSeconds = (performance.now() - started) / 1000;
  const state = await page.evaluate(() => window.cameraBackgroundProof.backgroundState());
  assert(state.fallbackFps < 15);
  assert.equal(state.selected, "none");
  assert(requests.some((url) => url.includes("vision_wasm")) && requests.some((url) => url.includes("selfie-segmenter")), "Picking Blur must load the self-hosted runtime");
  assert.deepEqual(await page.evaluate(() => window.cameraBackgroundProof.publication()), initial, "Fallback must retain the publication and track");
  assert.equal((await page.evaluate(() => window.cameraBackgroundProof.source())).live, true);
  const before = await page.evaluate(async () => (await window.cameraBackgroundProof.stats()).framesDecoded);
  await page.waitForFunction(async (before) => (await window.cameraBackgroundProof.stats()).framesDecoded > before + 6, before);
  const sampleStarted = performance.now();
  const first = await page.evaluate(async () => (await window.cameraBackgroundProof.stats()).framesDecoded);
  await page.waitForTimeout(2000);
  const last = await page.evaluate(async () => (await window.cameraBackgroundProof.stats()).framesDecoded);
  const plainCameraFps = ((last - first) * 1000) / (performance.now() - sampleStarted);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.keyboard.press("Escape");
  await page.getByRole("status").filter({ hasText: "Background off to keep video smooth." }).waitFor();
  await page.screenshot({ path: resolve(directory, "fallback-phone.png") });
  assert.deepEqual(errors, []);
  report.throttle = {
    rate,
    completedEffectFps: state.fallbackFps,
    plainCameraFps,
    elapsedSecondsIncludingLoad: elapsedSeconds,
    selected: state.selected,
    input: await page.evaluate(() => window.cameraBackgroundProof.source()),
    sourceLive: true,
    publicationRetained: true,
    remoteFramesContinue: true,
    lazyOnJoin: true,
    initialEffectRequests,
    effectRequestsAfterSelection: requests.filter(runtimeAsset).map((url) => url.replace(origin, "")),
    keyboardRing: ring,
    errors,
  };
  await save();
  await page.evaluate(() => window.cameraBackgroundProof.dispose());
} finally {
  await browser.close();
}
console.log(JSON.stringify(report));
