import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { installAgreementProbe } from "../../../scripts/web-proof/agreement.mjs";

const ENERGY_SAMPLE_MS = 40;
const POLL_MS = 100;
let invoke;
let waitForState;

export async function verifyStrictAutoplayUnlock(baseURL, executablePath, helpers) {
  invoke = helpers.invoke;
  waitForState = helpers.waitForState;
  const { chromium } = helpers;
  process.stdout.write("[autoplay] launching Chromium with document-user-activation-required\n");
  const strictBrowser = await chromium.launch({ headless: true, args: ["--autoplay-policy=document-user-activation-required"], ...(executablePath ? { executablePath } : {}) });
  const sender = await openStrictParticipant(strictBrowser, baseURL, "carol", "dark", false);
  const receivers = [
    { key: "desktop-dark", participant: "dan", width: 1440, height: 900, theme: "dark" },
    { key: "mobile-dark", participant: "erin", width: 390, height: 760, theme: "dark" },
    { key: "desktop-light", participant: "finn", width: 1440, height: 900, theme: "light" },
    { key: "mobile-light", participant: "gail", width: 390, height: 760, theme: "light" },
  ];
  for (const receiver of receivers) {
    receiver.session = await openStrictParticipant(strictBrowser, baseURL, receiver.participant, receiver.theme, true);
    await receiver.session.page.setViewportSize({ width: receiver.width, height: receiver.height });
    receiver.cdp = receiver.session.cdp;
  }
  try {
    // The sender's synthetic microphone is produced through an AudioContext, so
    // activate only that page. Receivers auto-join on load and are inspected only
    // through userGesture:false CDP evaluation until the real proof click.
    await sender.page.mouse.click(5, 5);
    await invoke(sender.page, "join");
    await waitForState(sender.page, "live");
    // Chalk auto-joins the sender before the test can click, so resume its fixture
    // capture context after that real activation.
    await invoke(sender.page, "resumeAudioContexts");
    for (const receiver of receivers) await waitForStrictPrompt(receiver);
    await captureStrictScreenshots(receivers);

    await proveStrictGesture(receivers[0]);
  } finally {
    const sessions = [sender, ...receivers.map(({ session }) => session)].filter(Boolean);
    await Promise.allSettled(sessions.map(({ page }) => invoke(page, "leave")));
    await Promise.allSettled(sessions.map(({ page }) => invoke(page, "dispose")));
    await Promise.allSettled(sessions.map(({ context }) => context.close()));
    await strictBrowser.close();
  }
}

async function proveStrictGesture(receiver) {
  const proof = receiver;
  const beforeClick = await evaluateNoGesture(proof.cdp, `window.__agreementAudio.filter((audio) => audio.srcObject).map((audio) => ({ paused: audio.paused, muted: audio.muted }))`);
  if (!beforeClick.some((audio) => audio.paused)) throw new TypeError(`Strict-autoplay receiver had no paused remote audio before the gesture: ${JSON.stringify(beforeClick)}`);
  const toastShown = await evaluateNoGesture(proof.cdp, `document.body.textContent.includes("Your browser paused the sound. Click anywhere to hear the class.")`);
  if (!toastShown) throw new TypeError("Strict-autoplay fallback toast disappeared before the proof tap");
  await proof.session.page.touchscreen.tap(200, 500);
  await waitForNoGesture(proof.cdp, `window.__chalk.snapshot().audioPlayback.blocked === false`, 10_000, "desktop-dark unblocked state");
  await waitForNoGesture(proof.cdp, `window.__agreementAudio.some((audio) => audio.srcObject && !audio.paused && !audio.muted)`, 10_000, "desktop-dark playing element");
  await waitForNoGesture(proof.cdp, `!document.body.textContent.includes("Your browser paused the sound. Click anywhere to hear the class.")`, 10_000, "desktop-dark prompt removal");
  const energy = await evaluateNoGesture(
    proof.cdp,
    `(async () => {
    const audio = window.__agreementAudio.findLast((element) => element.dataset.participantId === "carol" && element.srcObject && !element.paused && !element.muted);
    if (!audio) return 0;
    const context = new AudioContext();
    await context.resume();
    const source = context.createMediaStreamSource(audio.srcObject);
    const analyser = context.createAnalyser();
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let energy = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, ${ENERGY_SAMPLE_MS}));
      analyser.getFloatTimeDomainData(samples);
      energy = Math.max(energy, samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
    }
    source.disconnect();
    await context.close();
    return energy;
  })()`,
  );
  if (energy <= 0.00001) throw new TypeError(`Strict-autoplay receiver recovered no microphone energy after the gesture: ${energy}`);
  process.stdout.write(`[autoplay] strict gesture recovery passed; microphone energy ${energy}\n`);
}

async function waitForStrictPrompt(receiver) {
  await waitForNoGesture(receiver.cdp, `document.body.textContent.includes("Your browser paused the sound. Click anywhere to hear the class.")`, 10_000, `${receiver.key} prompt`);
  const blocked = await evaluateNoGesture(receiver.cdp, `window.__chalk.snapshot().audioPlayback.blocked`);
  if (blocked !== true) throw new TypeError(`${receiver.key} showed the prompt without the client blocked state`);
}

async function captureStrictScreenshots(receivers) {
  if (!process.env.CHALK_E2E_ARTIFACTS) return;
  await mkdir(process.env.CHALK_E2E_ARTIFACTS, { recursive: true });
  for (const receiver of receivers) await receiver.session.page.screenshot({ path: join(process.env.CHALK_E2E_ARTIFACTS, `autoplay-${receiver.key}.png`) });
}

async function openStrictParticipant(browser, baseURL, participant, theme, autojoin) {
  const context = await browser.newContext({ hasTouch: true });
  await context.addInitScript(installAgreementProbe);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`${baseURL}/?fixtureUser=${participant}&theme=${theme}${autojoin ? "&autojoin=1" : ""}`);
  await waitForNoGesture(cdp, `Boolean(window.__chalk)`, 10_000, `${participant} harness`);
  if (errors.length) throw errors[0];
  return { context, page, cdp };
}

async function evaluateNoGesture(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, userGesture: false });
  if (result.exceptionDetails) throw new TypeError(`Strict-autoplay evaluation failed: ${result.exceptionDetails.text}`);
  return result.result.value;
}

async function waitForNoGesture(cdp, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluateNoGesture(cdp, expression)) return;
    if (Date.now() > deadline) {
      const state = await evaluateNoGesture(
        cdp,
        `({ text: document.body.textContent, activation: { isActive: navigator.userActivation.isActive, hasBeenActive: navigator.userActivation.hasBeenActive }, playback: window.__chalk?.snapshot().audioPlayback, remote: window.__chalk?.snapshot().remoteMedia, audio: window.__agreementAudio?.map((element) => ({ participant: element.dataset.participantId, paused: element.paused, hasStream: Boolean(element.srcObject) })) })`,
      ).catch((error) => String(error));
      throw new TypeError(`Timed out waiting for ${label}: ${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
