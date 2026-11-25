import { checkDocExamples } from "./docs-examples.mjs";
import { proveToastLayering } from "./toast-layering.mjs";
import { forceAndWaitForRecovery } from "./recovery.mjs";
import { proveAgreementMatrix } from "./agreement.mjs";
import { installAgreementProbe } from "../../../scripts/web-proof/agreement.mjs";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { createRequire } from "node:module";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { spawnCommand } from "../../../scripts/lib/platform.mjs";
import { pnpmVersion } from "../../../scripts/lib/repository.mjs";

const fixtureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(fixtureDirectory, "../..");
const requireFromClient = createRequire(join(repositoryDirectory, "sdks/typescript/client/package.json"));
const { chromium, firefox, webkit, devices } = requireFromClient("playwright");
const arguments_ = new Set(process.argv.slice(2));
const browsersArgument = [...arguments_].find((argument) => argument.startsWith("--browsers="));
const requestedBrowsers = (browsersArgument?.split("=")[1] ?? "chromium,firefox,webkit").split(",").filter(Boolean);
const skipBuild = arguments_.has("--skip-build");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "chalk-sdk-web-consumer-"));
const archiveDirectory = join(temporaryDirectory, "archives");
const consumerDirectory = join(temporaryDirectory, "consumer");
const tenantAPIKey = `chalk_sk_fixture.${randomBytes(32).toString("base64url")}`;
const packedPackages = ["packages/assets", "packages/facehash", "packages/recording-presentation", "packages/ui", "sdks/typescript/client", "packages/screen-annotation", "packages/whiteboard", "sdks/typescript/react", "sdks/typescript/react-native"];
let serverProcess;

try {
  await mkdir(archiveDirectory);
  await cp(join(fixtureDirectory, "consumer"), consumerDirectory, { recursive: true });
  if (!skipBuild) {
    for (const packageDirectory of packedPackages) await run("pnpm", ["--dir", packageDirectory, "run", "build"], repositoryDirectory);
  }
  for (const packageDirectory of packedPackages) await run("pnpm", ["pack", "--pack-destination", archiveDirectory], join(repositoryDirectory, packageDirectory));
  const archives = (await readdir(archiveDirectory)).filter((file) => file.endsWith(".tgz"));
  const webArchives = Object.fromEntries(["chalk-client", "chalk-react", "chalk-assets", "facehash", "recording-presentation", "chalk-ui", "chalk-screen-annotation", "chalk-whiteboard"].map((name) => [`@q9labsai/${name}`, requiredArchive(archives, name)]));

  await writeFile(join(consumerDirectory, "package.json"), `${JSON.stringify({ name: "chalk-packed-web-consumer", private: true, type: "module", packageManager: `pnpm@${pnpmVersion}` }, null, 2)}\n`);
  await writeFile(join(consumerDirectory, "pnpm-workspace.yaml"), workspacePolicy(archiveDirectory, webArchives));
  await run(
    "pnpm",
    [
      "add",
      "--save-exact",
      ...Object.values(webArchives).map((archive) => join(archiveDirectory, archive)),
      "react@19.2.7",
      "react-dom@19.2.7",
      "@types/react@19.2.14",
      "@types/react-dom@19.2.3",
      "esbuild@0.28.1",
      "typescript@5.9.3",
      "@types/node@22.19.15",
      "effect@4.0.0-beta.102",
      "express@5",
      "@types/express@5",
      "hono@4",
      "ws@8.18.3",
      "tailwindcss@4.2.2",
      "@tailwindcss/cli@4.2.2",
      "tw-animate-css@1.4.0",
    ],
    consumerDirectory,
  );
  await assertPackedInstall(consumerDirectory, webArchives);
  const nativeDirectory = join(consumerDirectory, "node_modules/@q9labsai/chalk-react-native");
  await mkdir(nativeDirectory, { recursive: true });
  await run("tar", ["-xzf", join(archiveDirectory, requiredArchive(archives, "chalk-react-native")), "--strip-components=1", "-C", nativeDirectory], consumerDirectory);
  await checkDocExamples(repositoryDirectory, consumerDirectory, run);

  if (!arguments_.has("--docs-only")) {
    await run("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], consumerDirectory);
    await run(process.execPath, ["build.mjs"], consumerDirectory);
    await run("pnpm", ["exec", "tailwindcss", "--input", "styles.css", "--output", "dist/bundle.css"], consumerDirectory);

    serverProcess = spawn(process.execPath, ["server.mjs"], {
      cwd: consumerDirectory,
      env: { ...process.env, CHALK_API_KEY: tenantAPIKey },
      stdio: ["ignore", "pipe", "inherit"],
    });
    const baseURL = await listeningURL(serverProcess);
    const browserFailures = [];
    for (const browserName of requestedBrowsers) {
      const browserType = { chromium, firefox, webkit }[browserName];
      if (!browserType) throw new TypeError(`Unknown browser: ${browserName}`);
      try {
        const executablePath = browserName === "chromium" ? process.env.CHALK_E2E_CHROMIUM_EXECUTABLE : undefined;
        // SDK-driven join is not a trusted DOM gesture. Let the fixture's
        // synthetic tone run; receiver proof still samples the real gated sink.
        const browser = await browserType.launch({ headless: true, ...(browserName === "chromium" ? { args: ["--autoplay-policy=no-user-gesture-required"] } : {}), ...(executablePath ? { executablePath } : {}) });
        try {
          if (!arguments_.has("--agreement-only")) {
            await proveToastLayering(browser, baseURL);
            if (browserName === "chromium") {
              if (arguments_.has("--autoplay-only")) await verifyStrictAutoplayUnlock(baseURL, executablePath);
              else {
                await runChromiumMatrix(browser, baseURL, tenantAPIKey);
                await verifyStrictAutoplayUnlock(baseURL, executablePath);
              }
            } else await runLaunchSmoke(browser, browserName, baseURL);
          }
          if (browserName !== "firefox") {
            process.stdout.write(`[agreement] browser=${browserName}${browserName === "webkit" ? " profile=iPad Pro 11" : ""}\n`);
            // Linux WebKit: GStreamer "Switching from passthrough to parsebin"
            // / "not-negotiated (-4)"; VP8 also stalls outbound encoding.
            // macOS keeps frame checks. Re-enable the check on Linux WebKit once the GStreamer stall is gone.
            const checkCameraFrames = browserName !== "webkit" || process.platform !== "linux";
            if (!checkCameraFrames) process.stdout.write("[agreement] camera-frame assertion: known Linux WebKit engine stall; mic, controls, projections and badges remain required\n");
            await proveAgreementMatrix(browser, baseURL, { invoke, waitForState, device: browserName === "webkit" ? devices["iPad Pro 11"] : undefined, fast: arguments_.has("--agreement-fast"), checkCameraFrames });
          }
        } finally {
          await browser.close();
        }
        process.stdout.write(`[packed-e2e] ${browserName}: passed\n`);
      } catch (error) {
        if (!process.env.CI && browserUnavailable(error)) {
          process.stdout.write(`[packed-e2e] ${browserName}: skipped because its local Playwright binary is not installed\n`);
          continue;
        }
        browserFailures.push(new Error(`${browserName}: ${error.message}`, { cause: error }));
      }
    }
    if (browserFailures.length) throw new AggregateError(browserFailures, "Packed browser proofs failed");
  }
} finally {
  // Windows keeps a folder locked until its process has exited, so wait for the exit and retry a busy removal.
  if (serverProcess?.exitCode === null) {
    const exited = once(serverProcess, "exit");
    serverProcess.kill("SIGTERM");
    await exited;
  }
  await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

async function runChromiumMatrix(browser, baseURL, secretMarker) {
  const alice = await openParticipant(browser, baseURL, "alice");
  const bob = await openParticipant(browser, baseURL, "bob");
  try {
    await verifyPairJoined(alice.page, bob.page);
    await verifyCollaborations(alice.page, bob.page);
    await verifyImageAttachment(alice.page, bob.page);
    await verifyDirectedRequests(alice.page, bob.page);
    await verifyScreenShare(alice.page, bob.page);
    await verifyRecovery(alice.page, bob.page, baseURL);
    await verifyRemovalAndLeave(alice.page, bob.page);
    await verifyDeniedAccess(browser, baseURL);
    await verifyServerState(baseURL, secretMarker);
  } finally {
    await Promise.all([alice.context.close(), bob.context.close()]);
  }
}

async function verifyStrictAutoplayUnlock(baseURL, executablePath) {
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
  const promptBox = await evaluateNoGesture(
    proof.cdp,
    `(() => { const button = [...document.querySelectorAll("button")].find((element) => element.textContent === "Tap to turn on sound"); if (!button) return null; const box = button.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`,
  );
  if (!promptBox) throw new TypeError("Strict-autoplay prompt disappeared before the proof click");
  await proof.session.page.mouse.click(promptBox.x, promptBox.y);
  await waitForNoGesture(proof.cdp, `window.__chalk.snapshot().audioPlayback.blocked === false`, 10_000, "desktop-dark unblocked state");
  await waitForNoGesture(proof.cdp, `window.__agreementAudio.some((audio) => audio.srcObject && !audio.paused && !audio.muted)`, 10_000, "desktop-dark playing element");
  await waitForNoGesture(proof.cdp, `!document.body.textContent.includes("Tap to turn on sound")`, 10_000, "desktop-dark prompt removal");
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
      await new Promise((resolve) => setTimeout(resolve, 40));
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
  await waitForNoGesture(receiver.cdp, `document.body.textContent.includes("Tap to turn on sound")`, 10_000, `${receiver.key} prompt`);
  const blocked = await evaluateNoGesture(receiver.cdp, `window.__chalk.snapshot().audioPlayback.blocked`);
  if (blocked !== true) throw new TypeError(`${receiver.key} showed the prompt without the client blocked state`);
}

async function captureStrictScreenshots(receivers) {
  if (!process.env.CHALK_E2E_ARTIFACTS) return;
  await mkdir(process.env.CHALK_E2E_ARTIFACTS, { recursive: true });
  for (const receiver of receivers) await receiver.session.page.screenshot({ path: join(process.env.CHALK_E2E_ARTIFACTS, `autoplay-${receiver.key}.png`) });
}

async function openStrictParticipant(browser, baseURL, participant, theme, autojoin) {
  const context = await browser.newContext();
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
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function verifyDirectedRequests(alice, bob) {
  const unmute = await invoke(alice, "requestUnmute", "bob");
  if (unmute.status !== "delivered") throw new TypeError("Packed SDK unmute request was not delivered");
  await waitFor(bob, (snapshot, expected) => snapshot.incomingMediaRequests.some((request) => request.requestId === expected.requestId && request.kind === "unmute"), unmute);
  await invoke(bob, "declineMediaRequest", unmute.requestId);

  const camera = await invoke(alice, "requestStartCamera", "bob");
  if (camera.status !== "delivered") throw new TypeError("Packed SDK camera request was not delivered");
  await waitFor(bob, (snapshot, expected) => snapshot.incomingMediaRequests.some((request) => request.requestId === expected.requestId && request.kind === "start_camera"), camera);
  await invoke(bob, "declineMediaRequest", camera.requestId);
}

// Resting call controls fade and ignore the pointer until it moves, so move it
// the way a person would before reaching for the dock.
async function showCallControls(page) {
  const { width, height } = page.viewportSize();
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.move(width / 2 + 10, height / 2 + 10);
  await page.getByRole("toolbar", { name: "Space controls", exact: true }).hover();
}

async function verifyCollaborations(alice, bob) {
  const text = "Hello from the packed SDK: 👍 ❤️ 😂 😮 😢 🎉";
  const chatMessage = await invoke(alice, "sendChatMessage", { text });
  if (chatMessage.text !== text) throw new TypeError("Packed SDK chat action returned the wrong message");
  await waitFor(bob, (snapshot, expected) => snapshot.chat.messages.some((message) => message.clientMessageId === expected && message.participantId === "alice"), chatMessage.clientMessageId);
  await showCallControls(bob);
  await bob.getByRole("button", { name: "Chat", exact: true }).click();
  await bob.getByText(text, { exact: true }).waitFor({ state: "visible" });

  for (const emoji of ["👍", "❤️", "😂", "😮", "😢", "🎉"]) {
    const reaction = await invoke(bob, "sendReaction", emoji);
    if (reaction.reaction !== emoji) throw new TypeError("Packed SDK reaction action returned the wrong reaction");
    await waitFor(alice, (snapshot, expected) => snapshot.reactions.some((item) => item.eventId === expected.eventId && item.reaction === expected.reaction), reaction);
    await alice.getByText(emoji, { exact: true }).first().waitFor({ state: "visible" });
  }
}

async function verifyImageAttachment(sender, receiver, fileName = "packed-upload.png") {
  await showCallControls(sender);
  await sender.getByRole("button", { name: "Chat", exact: true }).click();
  const chooserReady = sender.waitForEvent("filechooser");
  await sender.getByRole("button", { name: "Attach files", exact: true }).click();
  const chooser = await chooserReady;
  await chooser.setFiles({ name: fileName, mimeType: "image/png", buffer: await readFile(join(repositoryDirectory, "apps/web/public/brand/chalk/chalk-icon-192.png")) });
  await sender.locator('[aria-label="Attachments"]').waitFor({ state: "visible" });
  await sender.getByRole("textbox", { name: "Message", exact: true }).fill("Image from the packed SDK");
  await sender.getByRole("button", { name: "Send message", exact: true }).click();
  await receiver.getByRole("img", { name: fileName, exact: true }).waitFor({ state: "visible" });
  await receiver.waitForFunction((expected) => [...document.images].some((image) => image.alt === expected && image.complete && image.naturalWidth > 0), fileName);
  await sender.getByRole("button", { name: "Close panel", exact: true }).click();
}

async function verifyPairJoined(alice, bob) {
  await Promise.all([invoke(alice, "join"), invoke(bob, "join")]);
  await Promise.all([waitForState(alice, "live"), waitForState(bob, "live")]);
  await Promise.all([
    waitFor(alice, (snapshot) => snapshot.participants.length === 2 && snapshot.remoteMedia.some((item) => item.participantId === "bob" && item.source === "camera" && item.readyState === "live")),
    waitFor(bob, (snapshot) => snapshot.participants.length === 2 && snapshot.remoteMedia.some((item) => item.participantId === "carol" && item.source === "camera" && item.readyState === "live")),
  ]);
}

async function verifyScreenShare(alice, bob) {
  await invoke(alice, "startScreenShare");
  await waitFor(bob, (snapshot) => snapshot.remoteMedia.some((item) => item.participantId === "carol" && item.source === "screen" && item.readyState === "live"));
  await invoke(alice, "stopScreenShare");
  await waitFor(bob, (snapshot) => !snapshot.remoteMedia.some((item) => item.participantId === "carol" && item.source === "screen"));
}

async function verifyRecovery(alice, bob, baseURL) {
  await Promise.all([waitForAccessRefresh(alice), waitForAccessRefresh(bob)]);
  await forceAndWaitForRecovery(alice, `${baseURL}/test/force-sync?participant=alice`, post, waitFor);
  await forceAndWaitForRecovery(bob, `${baseURL}/test/force-media?participant=bob`, post, waitFor);
}

async function verifyRemovalAndLeave(alice, bob) {
  await invoke(alice, "removeParticipant", "bob");
  await waitFor(alice, (snapshot) => !snapshot.participants.includes("bob") && !snapshot.remoteMedia.some((item) => item.participantId === "bob"));
  await Promise.all([invoke(alice, "leave"), invoke(bob, "leave")]);
  await Promise.all([invoke(alice, "dispose"), invoke(bob, "dispose")]);
  await Promise.all([waitForClean(alice), waitForClean(bob)]);
}

async function verifyDeniedAccess(browser, baseURL) {
  const denied = await openParticipant(browser, baseURL, "denied");
  try {
    const deniedCode = await denied.page.evaluate(tryDeniedJoin);
    if (deniedCode === "unexpected_success") throw new TypeError("Denied participant joined");
    await waitForDeniedAccess(denied.page);
    await invoke(denied.page, "leave");
    await invoke(denied.page, "dispose");
    await waitForClean(denied.page);
  } finally {
    await denied.context.close();
  }
}

async function waitForDeniedAccess(page) {
  await waitForSettledState(page, () => window.__chalk.snapshot().state === "failed" && Object.values(window.__chalk.resources()).every((count) => count === 0), 30_000, "Denied participant did not settle in the public failure state");
}

async function tryDeniedJoin() {
  try {
    await window.__chalk.join();
    return "unexpected_success";
  } catch (error) {
    if (error instanceof Error && "code" in error) return error.code;
    return "rejected";
  }
}

async function verifyServerState(baseURL, secretMarker) {
  const [stateResponse, bundleResponse] = await Promise.all([fetch(`${baseURL}/test/state`), fetch(`${baseURL}/bundle.js`)]);
  const [stateText, bundleText] = await Promise.all([stateResponse.text(), bundleResponse.text()]);
  assertCredentialAbsent(stateText, bundleText, secretMarker);
  const state = JSON.parse(stateText);
  assertServerResourcesReleased(state, stateText);
  assertSyncRecovered(state);
  assertMediaRecovered(state);
  assertRefreshReasons(state, stateText);
}

function assertCredentialAbsent(stateText, bundleText, secretMarker) {
  if (stateText.includes(secretMarker) || bundleText.includes(secretMarker)) throw new TypeError("The backend credential entered a browser-readable response or bundle");
}

function assertServerResourcesReleased(state, stateText) {
  if (state.activeParticipants.length !== 0) throw new TypeError(`Server participants leaked after Leave: ${stateText}`);
  if (state.sockets.sync !== 0) throw new TypeError(`Server Sync sockets leaked after Leave: ${stateText}`);
  if (state.sockets.media !== 0) throw new TypeError(`Server media sockets leaked after Leave: ${stateText}`);
}

function assertSyncRecovered(state) {
  if (state.metrics.syncConnections < 3) throw new TypeError("Forced Sync recovery did not establish a replacement connection");
}

function assertMediaRecovered(state) {
  if (state.metrics.mediaReplacements < 1) throw new TypeError("Forced media recovery did not request replacement access");
  if (state.metrics.mediaConnections < 3) throw new TypeError("Forced media recovery did not establish replacement signaling");
}

function assertRefreshReasons(state, stateText) {
  if (!state.metrics.accessReasons.includes("refresh")) throw new TypeError(`Scheduled access refresh was not observed: ${stateText}`);
  if (!state.metrics.accessReasons.includes("retry")) throw new TypeError(`Media recovery access was not observed: ${stateText}`);
}

async function runLaunchSmoke(browser, browserName, baseURL) {
  const participant = await openParticipant(browser, baseURL, browserName);
  try {
    await invoke(participant.page, "join");
    await waitForState(participant.page, "live");
    await invoke(participant.page, "setCameraEnabled", false);
    await invoke(participant.page, "setCameraEnabled", true);
    await invoke(participant.page, "setMicrophoneEnabled", false);
    await invoke(participant.page, "setMicrophoneEnabled", true);
    await invoke(participant.page, "startScreenShare");
    await invoke(participant.page, "stopScreenShare");
    await verifyImageAttachment(participant.page, participant.page, `${browserName}-upload.png`);
    await invoke(participant.page, "leave");
    await invoke(participant.page, "dispose");
    await waitForClean(participant.page);
  } finally {
    await participant.context.close();
  }
}

async function openParticipant(browser, baseURL, participant, agreementProbe = false, theme) {
  const context = await browser.newContext();
  if (agreementProbe) await context.addInitScript(installAgreementProbe);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`${baseURL}/test/login?user=${participant}`);
  if (theme) await page.goto(`${baseURL}/?theme=${theme}`);
  await page.waitForFunction(() => Boolean(window.__chalk));
  if (errors.length) throw errors[0];
  return { context, page };
}

function invoke(page, action, argument) {
  return page.evaluate(
    ([name, value]) => {
      const pendingInvocations = (window.__chalkPendingInvocations ??= new Set());
      const invocation = Promise.resolve(window.__chalk[name](...(value === undefined ? [] : [value])));
      const retainedInvocation = invocation.finally(() => pendingInvocations.delete(retainedInvocation));
      pendingInvocations.add(retainedInvocation);
      return retainedInvocation;
    },
    [action, argument],
  );
}

function waitForState(page, state, timeoutMs) {
  return waitFor(page, (snapshot, expected) => snapshot.state === expected, state, timeoutMs);
}

async function waitFor(page, predicate, argument, timeoutMs = 10_000) {
  try {
    await page.waitForFunction(([source, value]) => Function("snapshot", "value", `return (${source})(snapshot, value)`)(window.__chalk.snapshot(), value), [String(predicate), argument], { timeout: timeoutMs });
  } catch (error) {
    const snapshot = await page.evaluate(() => window.__chalk.snapshot());
    process.stderr.write(`[packed-e2e] timed out with snapshot ${JSON.stringify(snapshot)}\n`);
    throw error;
  }
}

async function waitForAccessRefresh(page) {
  await page.waitForFunction(() => window.__chalk.accessReasons().includes("refresh"), null, { timeout: 10_000 });
}

async function waitForClean(page) {
  const isClean = () => {
    const snapshot = window.__chalk.snapshot();
    const resources = window.__chalk.resources();
    return snapshot.state === "left" && Object.values(resources).every((count) => count === 0);
  };
  await waitForSettledState(page, isClean, 5_000, "Packed SDK resources did not settle after Leave");
}

async function waitForSettledState(page, predicate, timeout, message) {
  try {
    await page.waitForFunction(predicate, null, { timeout });
  } catch (cause) {
    const state = await page.evaluate(() => ({ snapshot: window.__chalk.snapshot(), resources: window.__chalk.resources() }));
    throw new TypeError(`${message}: ${JSON.stringify(state)}`, { cause });
  }
}

async function post(url, signal) {
  const response = await fetch(url, { method: "POST", signal });
  if (!response.ok) throw new TypeError(`Fixture control request failed with HTTP ${response.status}: ${url}`);
}

async function assertPackedInstall(directory, archives) {
  const packageJSON = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  for (const [packageName, archive] of Object.entries(archives)) assertArchiveDependency(packageJSON, packageName, archive);

  await run(
    process.execPath,
    [
      "-e",
      'const { createRequire } = require("node:module"); const { readFileSync } = require("node:fs"); const { dirname, join } = require("node:path"); for (const name of ["@q9labsai/chalk-client", "@q9labsai/chalk-client/effect", "@q9labsai/chalk-react", "@q9labsai/chalk-react/preview", "@q9labsai/recording-presentation"]) { const path = require.resolve(name); if (!path.includes("node_modules") || path.includes("/src/")) throw new Error(`${name} did not resolve to a built artifact from the clean install`); }',
    ],
    directory,
  );
}

function assertArchiveDependency(packageJSON, packageName, archive) {
  const specifier = packageJSON.dependencies?.[packageName];
  if (!String(specifier).includes(archive)) throw new TypeError(`The clean consumer did not record packed dependency ${packageName}`);
}

function requiredArchive(archives, name) {
  const prefix = `q9labsai-${name}-`;
  const archive = archives.find((file) => file.startsWith(prefix) && /^\d/.test(file.slice(prefix.length)));
  if (!archive) throw new TypeError(`pnpm pack did not produce ${name}`);
  return archive;
}

function workspacePolicy(archiveDirectory_, archives) {
  const overrides = Object.entries(archives).map(([name, archive]) => `  "${name}": "file:${join(archiveDirectory_, archive).replaceAll("\\", "/")}"`);
  return [
    "packages:",
    '  - "."',
    "# Packed workspace dependencies must resolve to artifacts from this run, never to the registry.",
    "overrides:",
    ...overrides,
    "# Only esbuild needs a build script in this browser fixture; explicitly deny the repository's other scripts.",
    "allowBuilds:",
    '  "@parcel/watcher": false',
    "  esbuild: true",
    "  lefthook: false",
    "  msgpackr-extract: false",
    "  msw: false",
    "  workerd: false",
    "# This exact beta is pinned by the packed SDK; the exclusion only accommodates pnpm's machine-local no-downgrade trust policy.",
    "trustPolicyExclude:",
    '  - "effect@4.0.0-beta.102"',
    "",
  ].join("\n");
}

function browserUnavailable(error) {
  return error instanceof Error && /Executable doesn't exist|browserType\.launch: Executable/u.test(error.message);
}

function listeningURL(child) {
  return new Promise((resolveListening, reject) => {
    let buffer = "";
    child.once("error", reject);
    child.once("exit", (code) => reject(new TypeError(`Fixture server exited before listening with code ${code}`)));
    child.stdout.on("data", (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const message = JSON.parse(buffer.slice(0, newline));
      if (message.type === "listening") resolveListening(message.url);
    });
  });
}

function run(command, arguments__, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawnCommand(command, arguments__, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolveRun() : reject(new TypeError(`${command} ${arguments__.join(" ")} exited with code ${code}`))));
  });
}
