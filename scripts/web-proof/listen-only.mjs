import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as joinPath, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices, webkit } from "playwright";
import { cleanupRun } from "../prod-proof/cleanup.mjs";
import { createProofKey, createSpace } from "../prod-proof/proofs.mjs";
import { createRun, loadConfig, maskCredentials, save } from "../prod-proof/runtime.mjs";
import { webMediaFixture } from "./media.mjs";

// Use nightly-stack/boot --web-https so WebKit stores the Secure guest cookie.
// Run under xvfb-run with the stack's proof.env and NODE_EXTRA_CA_CERTS pointing to web-ca.crt.
const hiddenMs = 315_000;
const receiveMs = 8_000;
const runId = `listen-only-${randomUUID()}`;
const directory = resolve(process.env.CHALK_LISTEN_ONLY_DIRECTORY ?? `.private/web-proof/${runId}`);
const report = {};
const browsers = [];
const interruption = new AbortController();
const { signal } = interruption;
const stop = (name) => interruption.abort(name);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
let edgeProcess;
let edgeProfile;
let run;
let failed = false;
let stage = "setup";
try {
  assert.equal(process.env.CHALK_PROOF_CONFIG_SOURCE, "env");
  for (const name of ["CHALK_PROOF_API_URL", "CHALK_PROOF_WEB_URL"]) {
    const url = new URL(process.env[name]);
    assert.equal(url.hostname, "127.0.0.1", "Use the throwaway loopback stack");
    assert.equal(url.protocol, "https:", "Use --web-https to test Secure cookies");
  }
  // Own a fresh Space so cleanup never changes a shared invite.
  assert.ok(!process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU && process.env.CHALK_PROOF_SPACE_BY_SLUG !== "true");
  const config = await loadConfig({ capabilities: false });
  signal.throwIfAborted();
  run = await createRun(config, directory, signal, runId);
  await createProofKey(run);
  const space = await createSpace(run, "chalk_sfu");
  await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: runId } });
  const invite = await run.ownerRequest("PATCH", `${run.tenantPath}/spaces/${space.id}/public-invite`, { enabled: true });
  const url = new URL(invite.canonical_url);
  maskCredentials({ inviteToken: url.hash.slice(1), canonicalCredential: invite.canonical_url });
  const entry = new URL(url.pathname + url.search + url.hash, config.web_url).href;
  stage = "join";
  signal.throwIfAborted();
  const safari = keepBrowser(await webkit.launch({ headless: false, handleSIGINT: false, handleSIGTERM: false }));
  const edge = await launchEdge();
  const listeners = await Promise.all([join(edge.contexts()[0], entry, "Edge listener", 1), join(await safari.newContext({ ...devices["iPad Pro 11"], ignoreHTTPSErrors: true }), entry, "WebKit listener", 2)]);
  await Promise.all(listeners.map(checkEmptyJoin));
  stage = "background through grant renewal";
  await Promise.all([backgroundThroughRefresh(listeners[0], hideEdgeTab), backgroundThroughRefresh(listeners[1], hideWebKitPage)]);
  stage = "receive from late publisher";
  const publisher = await join(await edge.newContext(), entry, "Publisher", 3);
  await control(publisher.page, "Unmute microphone");
  await control(publisher.page, "Turn on camera");
  await Promise.all(listeners.map(checkDelivery));
  failed = listeners.some(({ evidence }) => Object.values(evidence.journeys).some((passed) => !passed));
} catch (error) {
  failed = true;
  // Locator errors may include an invite URL. Save the step results, not raw errors.
  report.error = { stage, name: signal.aborted ? "AbortError" : error.name };
} finally {
  await Promise.allSettled(browsers.map((browser) => browser.close()));
  if (edgeProcess?.exitCode === null && edgeProcess.signalCode === null) {
    edgeProcess.kill();
    await new Promise((done) => edgeProcess.once("exit", done));
  }
  if (edgeProfile) await rm(edgeProfile, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  if (run) {
    try {
      await cleanupRun(run);
      report.cleanup = "passed";
    } catch {
      report.cleanup = "failed";
      failed = true;
    }
    if (signal.aborted) report.interruptedBy = signal.reason;
    failed ||= signal.aborted;
    await save(`${directory}/listen-only-report.json`, { ...report, result: failed ? "failed" : "passed" });
  }
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
console.log(`Listen-only proof ${failed ? "failed" : "passed"}: ${directory}/listen-only-report.json`);
process.exitCode = signal.reason === "SIGINT" ? 130 : signal.reason === "SIGTERM" ? 143 : failed ? 1 : 0;

function keepBrowser(browser) {
  browsers.push(browser);
  return browser;
}

async function launchEdge() {
  // Playwright-launched Chromium forces each page to appear focused. Connect to a
  // regular Edge window so a tab switch produces a real visibility change.
  edgeProfile = await mkdtemp(joinPath(tmpdir(), "chalk-listener-edge-"));
  edgeProcess = spawn("microsoft-edge", [`--user-data-dir=${edgeProfile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors", "about:blank"], { stdio: "ignore" });
  return Promise.race([
    new Promise((_, reject) => edgeProcess.once("error", reject)),
    (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const endpoint = await readFile(joinPath(edgeProfile, "DevToolsActivePort"), "utf8").catch(() => "");
        if (endpoint) return keepBrowser(await chromium.connectOverCDP(`http://127.0.0.1:${endpoint.split("\n")[0]}`, { noDefaults: true }));
        await delay(150, undefined, { signal });
      }
      throw new Error("Edge did not start");
    })(),
  ]);
}

async function join(context, entry, name, fixture) {
  await context.addInitScript(webMediaFixture(fixture, { permission: "granted" }));
  await context.addInitScript(() => {
    window.proofReconnected = false;
    window.proofVisibility = [];
    document.addEventListener("visibilitychange", () => window.proofVisibility.push(document.visibilityState));
    new MutationObserver(() => {
      if (document.querySelector('[data-part="connection-status"]')) window.proofReconnected = true;
    }).observe(document, { childList: true, subtree: true });
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const evidence = (report[name] = { journeys: {}, refreshes: [], mediaErrors: [] });
  let initialBinding;
  let initialExpiry;
  const responses = [];
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (!path.startsWith("/v1/")) return;
    const refresh = path === "/v1/public/space-invite-arrival/access-grants";
    const arrival = path === "/v1/public/space-invite-arrivals" || (path === "/v1/public/space-invite-arrival" && response.request().method() === "GET");
    if (!refresh && !arrival && ![404, 409].includes(response.status())) return;
    const renewal = refresh ? { status: response.status(), sameBinding: false, extendedExpiry: false } : null;
    if (renewal) evidence.refreshes.push(renewal);
    responses.push(
      response
        .json()
        .then((body) => {
          const media = (refresh ? body : body.access)?.media;
          if (arrival && media && !initialBinding) {
            initialBinding = media.client_payload.connectionId;
            initialExpiry = media.expires_at;
          }
          if (renewal) {
            renewal.sameBinding = initialBinding !== undefined && media?.client_payload.connectionId === initialBinding;
            renewal.extendedExpiry = initialExpiry !== undefined && media?.expires_at > initialExpiry;
          }
          const code = body.error?.code ?? body.code;
          if (code === "media.connection_not_found" || code === "access.media_proof_expired") evidence.mediaErrors.push(code);
        })
        .catch(() => {}),
    );
  });
  await page.goto(entry);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await page.getByRole("region", { name: "Space stage", exact: true }).waitFor({ timeout: 30_000 });
  const cookies = await context.cookies(entry);
  assert.ok(
    cookies.some(({ name, secure }) => secure && name.startsWith("__Host-chalk_space_guest_")),
    "Browser did not store the Secure guest cookie",
  );
  return { name, page, context, evidence, responses };
}

async function checkEmptyJoin({ page, name, evidence }) {
  await control(page, "Unmute microphone", { waitOnly: true });
  await control(page, "Turn on camera", { waitOnly: true });
  evidence.emptyConnected = await waitFor(
    page,
    () => {
      const [peer] = window.proofConnections;
      return peer?.connectionState === "connected" && peer.getSenders().every((sender) => sender.track === null);
    },
    receiveMs,
  );
  await page.screenshot({ path: `${directory}/${name}-joined.png` });
}

async function hideEdgeTab({ context, page, evidence }) {
  const cdp = await context.newCDPSession(page);
  const blankTab = await cdp.send("Target.createTarget", { url: "about:blank", newWindow: false });
  evidence.visibilityControl = "native tab switch";
  return () => cdp.send("Target.closeTarget", blankTab);
}

async function hideWebKitPage({ page, evidence }) {
  // Linux WebKit treats its automation view as visible even when minimized.
  // Replay the visibility signal without changing timers, signaling, or media.
  evidence.visibilityControl = "injected WebKit visibility";
  const setVisibility = (state) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    Object.defineProperty(document, "hidden", { configurable: true, value: state === "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  await page.evaluate(setVisibility, "hidden");
  return () => page.evaluate(setVisibility, "visible");
}

async function backgroundThroughRefresh(participant, hide) {
  const { page, name, evidence, responses } = participant;
  const restore = await hide(participant);
  evidence.wentHidden = await waitFor(page, () => document.hidden, 5_000);
  const transitionsAtHide = await page.evaluate(() => window.proofVisibility.length);
  const refreshesAtHide = evidence.refreshes.length;
  const started = performance.now();
  console.log(`${name}: empty transport connected=${evidence.emptyConnected}, hidden=${evidence.wentHidden}`);
  await run.wait(hiddenMs);
  // Snapshot response events before the visibility callback can trigger a refresh.
  const refreshesWhileHidden = evidence.refreshes.length - refreshesAtHide;
  evidence.hiddenDurationMs = Math.round(performance.now() - started);
  await restore();
  const foreground = await waitFor(page, () => !document.hidden, 5_000);
  await Promise.all(responses);
  const state = await page.evaluate(
    (start) => ({
      peerStates: window.proofConnections.map((peer) => peer.connectionState),
      reconnected: window.proofReconnected,
      continuouslyHidden: window.proofVisibility.slice(start).join() === "visible",
    }),
    transitionsAtHide,
  );
  Object.assign(evidence, state);
  evidence.journeys.background = evidence.wentHidden && state.continuouslyHidden && foreground && !state.reconnected && state.peerStates.join() === "connected";
  evidence.hiddenRefreshCount = evidence.wentHidden && state.continuouslyHidden ? refreshesWhileHidden : 0;
  evidence.journeys.refresh = evidence.hiddenRefreshCount > 0 && evidence.refreshes.every(({ status, sameBinding, extendedExpiry }) => status === 201 && sameBinding && extendedExpiry) && evidence.mediaErrors.length === 0;
  await page.screenshot({ path: `${directory}/${name}-returned.png` });
}

async function checkDelivery({ page, name, evidence, responses }) {
  const started = Date.now();
  const media = await waitFor(
    page,
    async () => {
      const [peer, ...replacements] = window.proofConnections;
      if (!peer || replacements.length || peer.connectionState !== "connected") return false;
      const reports = [...(await peer.getStats()).values()];
      const audio = reports.some((row) => row.type === "inbound-rtp" && (row.kind ?? row.mediaType) === "audio" && (row.totalAudioEnergy > 0 || row.audioLevel > 0));
      const video = document.querySelector('[aria-label="Video tile for Publisher"]')?.closest('[data-part="stage-tile"]')?.querySelector("video");
      return audio && video?.readyState >= 2 && video.getVideoPlaybackQuality().totalVideoFrames > 5;
    },
    receiveMs,
  );
  await Promise.all(responses);
  evidence.mediaAfterPublishMs = media ? Date.now() - started : null;
  evidence.journeys.latePublisher = evidence.emptyConnected && media && evidence.mediaErrors.length === 0;
  await page.screenshot({ path: `${directory}/${name}-publisher.png` });
}

async function waitFor(page, predicate, timeout) {
  const deadline = Date.now() + timeout;
  do {
    signal.throwIfAborted();
    if (await page.evaluate(predicate)) return true;
    await delay(100, undefined, { signal });
  } while (Date.now() < deadline);
  return false;
}

async function control(page, name, { waitOnly = false } = {}) {
  await page.getByRole("region", { name: "Space stage", exact: true }).hover();
  const button = page.getByRole("button", { name, exact: true });
  if (waitOnly) await button.waitFor({ timeout: 10_000 });
  else await button.click({ timeout: 10_000 });
}
