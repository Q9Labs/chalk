#!/usr/bin/env node
// The class journey for a Participant on a phone or tablet. The Participant opens the class link on the device, allows the
// camera and microphone, joins, sees and hears the host, sees the host's screen share, sees and draws on the whiteboard,
// is backgrounded and returns, rotates, and leaves. The host is a desktop Chromium that starts the call.
// Only the camera, the microphone and the shared screen are fakes; the touch is emulated, not a real finger.
//
//   node .agents/skills/verify-chalk/scripts/class-journey.mjs <run-id> --device ipad|iphone|android [--web <origin>]
import { paintedInk } from "./board-ink.mjs";
import { runJourney } from "./journey.mjs";
import { incomingAudioLevel } from "../../../../scripts/web-proof/media.mjs";
import { measureAdvance, measureFirstFrame } from "../../../../scripts/web-proof/tile-diagnostics.mjs";

const flag = process.argv.indexOf("--device");
const device = flag > 0 ? process.argv[flag + 1] : undefined;
if (!["ipad", "iphone", "android"].includes(device ?? "")) throw new Error("usage: class-journey.mjs <run-id> --device ipad|iphone|android [--web <origin>]");

const waitMs = 60_000;

// The host shares a moving picture instead of a real screen. Runs in the host page before the app loads.
function fakeScreen() {
  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext("2d");
  let frame = 0;
  setInterval(() => {
    context.fillStyle = "#102a43";
    context.fillRect(0, 0, 1280, 720);
    context.fillStyle = "white";
    context.font = "72px sans-serif";
    context.fillText(`Shared screen ${frame++}`, 80, 160);
    context.fillRect((frame * 9) % 1100, 300, 160, 160);
  }, 1000 / 15);
  navigator.mediaDevices.getDisplayMedia = async () => canvas.captureStream(15);
}

function screenFrames(name) {
  const tile = document.querySelector(`[aria-label="Screen share tile for ${name}"]`)?.closest("[data-stage-item]");
  const video = tile?.querySelector("video");
  return video && video.readyState >= 2 && video.videoWidth > 0 ? video.getVideoPlaybackQuality().totalVideoFrames : 0;
}

// Android Chrome takes real touch input over CDP. WebKit has no CDP, and Playwright's touchscreen only taps, so the iPad and
// iPhone draw with the pointer: the board sees the same pointer events but not a finger, so a finger's touch-action is checked instead.
async function drawStroke(who, from, to) {
  const box = await who.page.locator(".chalk-board").first().boundingBox();
  if (!box) throw new Error("The board did not open");
  const at = (point) => ({ x: box.x + box.width * point.x, y: box.y + box.height * point.y });
  const [a, b] = [at(from), at(to)];
  if (who.device !== "android") {
    await who.page.mouse.move(a.x, a.y);
    await who.page.mouse.down();
    await who.page.mouse.move(b.x, b.y, { steps: 12 });
    await who.page.mouse.up();
    return "pointer";
  }
  const cdp = await who.context.newCDPSession(who.page);
  const touch = (type, point) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchEnd" ? [] : [{ x: point.x, y: point.y }] });
  await touch("touchStart", a);
  for (let step = 1; step <= 12; step++) await touch("touchMove", { x: a.x + ((b.x - a.x) * step) / 12, y: a.y + ((b.y - a.y) * step) / 12 });
  await touch("touchEnd", b);
  return "touch";
}

// A finger on the board must draw, not scroll or zoom the page: the board canvas has to opt out of the browser's touch gestures.
function boardTouchAction() {
  const canvas = document.querySelector(".chalk-board canvas.interactive") ?? document.querySelector(".chalk-board canvas:last-of-type");
  return canvas ? getComputedStyle(canvas).touchAction : null;
}

function pageOverflow() {
  return { overflowX: document.documentElement.scrollWidth - window.innerWidth, width: window.innerWidth, height: window.innerHeight };
}

await runJourney(`class-${device}`, async ({ step, person, startCall, leave, shot, control }) => {
  const host = await person("ClassHost", 1);
  await host.context.addInitScript(fakeScreen);
  const me = await person(`Participant-${device}`, 2, { device });
  const hostName = host.name;
  const myName = me.name;
  let link;

  // Controls hide until the stage is touched or hovered; a finger taps, a mouse hovers.
  const reveal = (who) => (who.device === "desktop" ? who.page.getByRole("region", { name: "Space stage", exact: true }).hover() : who.page.getByRole("region", { name: "Space stage", exact: true }).tap());
  const press = async (who, name) => {
    await reveal(who);
    await who.page.getByRole("button", { name, exact: true }).click();
  };

  await step("the host starts the class", async () => {
    ({ link } = await startCall(host));
    await control(host, "Unmute microphone");
    await control(host, "Turn on camera");
  });

  await step("opens the class link on the device and sees the entrance", async () => {
    await me.page.goto(link);
    await me.page.getByLabel("Your name", { exact: true }).waitFor({ timeout: waitMs });
    await shot(me, "01-entrance");
  });

  await step("allows the camera and microphone and joins", async () => {
    const join = me.page.getByRole("button", { name: "Join call", exact: true });
    const name = me.page.getByLabel("Your name", { exact: true });
    // Typing before the page hydrates loses the name, so type until the form accepts it.
    for (let attempt = 0; attempt < 20 && !(await join.isEnabled()); attempt++) {
      await name.fill(myName);
      await me.page.waitForTimeout(250);
    }
    const sheet = me.page.getByRole("dialog", { name: "Camera and microphone" });
    await sheet.waitFor({ timeout: 15_000 });
    await shot(me, "02-camera-microphone-sheet");
    await sheet.getByRole("button", { name: "Turn on", exact: true }).click();
    await sheet.waitFor({ state: "detached", timeout: 15_000 });
    await shot(me, "03-ready-to-join");
    await join.click();
    await me.page.getByRole("button", { name: `Video tile for ${myName}`, exact: true }).waitFor({ timeout: waitMs });
    await shot(me, "04-joined");
  });

  await step("sees the host's video moving and hears the host", async () => {
    const first = await measureFirstFrame(me.page, hostName, { timeoutMs: waitMs });
    if (first.firstFrameMs === null) throw new Error(`no host frame on the ${device}: ${JSON.stringify(first.state)}`);
    const advance = await measureAdvance(me.page, hostName, { timeoutMs: waitMs });
    if (advance.advancedAfterMs === null) throw new Error(`the host's video did not advance on the ${device}`);
    // Playing audio needs the page's own element; the SDK already attaches one, so the received level is the evidence.
    const deadline = Date.now() + waitMs;
    let level = 0;
    while (level <= 0 && Date.now() < deadline) {
      level = await me.page.evaluate(incomingAudioLevel);
      if (level <= 0) await me.page.waitForTimeout(500);
    }
    if (level <= 0) throw new Error(`no incoming audio on the ${device}`);
    await shot(me, "05-sees-and-hears-host");
    return { firstFrameMs: first.firstFrameMs, advancedAfterMs: advance.advancedAfterMs, audioLevel: level };
  });

  await step("the host sees the device's video and hears it", async () => {
    const advance = await measureAdvance(host.page, myName, { timeoutMs: waitMs });
    if (advance.advancedAfterMs === null) throw new Error(`the ${device}'s video did not reach the host`);
    let level = 0;
    const deadline = Date.now() + waitMs;
    while (level <= 0 && Date.now() < deadline) {
      level = await host.page.evaluate(incomingAudioLevel);
      if (level <= 0) await host.page.waitForTimeout(500);
    }
    if (level <= 0) throw new Error(`the host heard nothing from the ${device}`);
    await shot(host, "host-sees-participant");
  });

  await step("sees the host's screen share", async () => {
    await control(host, "Share screen");
    const tile = me.page.getByLabel(`Screen share tile for ${hostName}`);
    await tile.waitFor({ timeout: waitMs });
    const deadline = Date.now() + waitMs;
    let before = 0;
    while (before === 0 && Date.now() < deadline) {
      before = await me.page.evaluate(screenFrames, hostName);
      if (before === 0) await me.page.waitForTimeout(500);
    }
    if (before === 0) throw new Error(`no screen share frame on the ${device}`);
    await me.page.waitForTimeout(3000);
    const after = await me.page.evaluate(screenFrames, hostName);
    if (after <= before + 5) throw new Error(`the screen share did not advance on the ${device} (${before} -> ${after})`);
    await shot(me, "06-screen-share");
    return { before, after };
  });

  await step("sees the whiteboard the host opens", async () => {
    await control(host, "Board");
    await me.page.locator(".chalk-board[data-ready]").first().waitFor({ timeout: waitMs });
    await me.page.waitForTimeout(1500);
    await shot(me, "07-whiteboard");
  });

  await step("draws on the whiteboard with touch and the host sees the stroke", async () => {
    const board = me.page.locator(".chalk-board").first();
    // A Participant draws while following the host: the pen is the board's current tool. Fall back to the tool tray if it is not.
    const pen = me.page.getByRole("button", { name: "Pen", exact: true });
    const trigger = me.page.getByRole("button", { name: /^Tools: |^Open drawing tools$/ }).first();
    if (!(await pen.isVisible()) && (await trigger.isVisible())) await trigger.click();
    // On a phone the pen is already the current tool once the tray is open, so it is only pressed when it is listed.
    if (await pen.isVisible()) await pen.click();
    const before = Number(await board.getAttribute("data-elements"));
    const touchAction = await me.page.evaluate(boardTouchAction);
    if (touchAction !== "none") throw new Error(`the board canvas has touch-action ${touchAction}, so a finger would scroll the page instead of drawing`);
    const input = await drawStroke(me, { x: 0.2, y: 0.3 }, { x: 0.6, y: 0.5 });
    await me.page
      .locator(`.chalk-board[data-elements="${before + 1}"]`)
      .first()
      .waitFor({ timeout: 30_000 });
    await host.page
      .locator(`.chalk-board[data-elements="${before + 1}"]`)
      .first()
      .waitFor({ timeout: 30_000 });
    // A scene can hold the stroke while the canvas stays blank, so read the painted pixels on both screens.
    const ink = [await paintedInk(me.page, (pixels) => pixels > 0), await paintedInk(host.page, (pixels) => pixels > 0)];
    await shot(me, "08-whiteboard-drawn");
    return { input, touchAction, ink };
  });

  await step("goes to the background briefly and comes back", async () => {
    const framesBefore = await me.page.evaluate(([name]) => document.querySelectorAll("video").length, [hostName]);
    await me.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    await me.page.waitForTimeout(8000);
    await me.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    });
    const advance = await measureAdvance(me.page, hostName, { timeoutMs: waitMs });
    if (advance.advancedAfterMs === null) throw new Error(`the host's video did not resume on the ${device} after coming back`);
    const reconnecting = await me.page.getByText(/reconnecting|connection lost/i).count();
    if (reconnecting > 0) throw new Error(`the ${device} still shows a reconnecting or connection lost notice`);
    await shot(me, "09-after-background");
    return { videos: framesBefore };
  });

  await step("rotates the device", async () => {
    const portrait = me.page.viewportSize();
    const fits = [];
    for (const size of [{ width: portrait.height, height: portrait.width }, portrait]) {
      await me.page.setViewportSize(size);
      await me.page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
      await me.page.waitForTimeout(1500);
      const stage = await me.page.getByRole("region", { name: "Space stage", exact: true }).boundingBox();
      const overflow = await me.page.evaluate(pageOverflow);
      fits.push({ ...overflow, stage: stage && { width: Math.round(stage.width), height: Math.round(stage.height), inside: stage.x >= -1 && stage.y >= -1 && stage.x + stage.width <= overflow.width + 1 && stage.y + stage.height <= overflow.height + 1 } });
      await shot(me, size === portrait ? "11-portrait-again" : "10-landscape");
      const orientation = size === portrait ? "portrait" : "landscape";
      // With the board primary a short stage folds people into a "+N" tile, so the host is checked through the people list there.
      const more = me.page.getByRole("button", { name: /^Show \d+ more participants$/ });
      if (await more.count()) {
        await more.click();
        const listed = await me.page.getByRole("dialog").getByText(hostName).count();
        await me.page.keyboard.press("Escape");
        if (!listed) throw new Error(`the "+N" tile on the ${device} in ${orientation} did not list the host`);
        continue;
      }
      const advance = await measureAdvance(me.page, hostName, { timeoutMs: waitMs });
      if (advance.advancedAfterMs === null) throw new Error(`the host's video stopped after rotating to ${orientation} on the ${device}`);
    }
    for (const fit of fits) {
      if (fit.overflowX > 1 || !fit.stage || !fit.stage.inside) throw new Error(`layout overflows after rotating: ${JSON.stringify(fit)}`);
    }
    return fits;
  });

  await step("leaves the class", async () => {
    await press(me, "Leave call");
    await me.page.getByRole("button", { name: "Rejoin", exact: true }).waitFor({ timeout: 30_000 });
    await shot(me, "12-left");
    await leave(host);
  });
});
