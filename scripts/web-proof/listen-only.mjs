import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices, webkit } from "playwright";
import { cleanupRun } from "../prod-proof/cleanup.mjs";
import { createSpace, prepareIntegration } from "../prod-proof/proofs.mjs";
import { createRun, loadConfig, maskCredentials, save } from "../prod-proof/runtime.mjs";
import { webMediaFixture } from "./media.mjs";

// Run against the loopback nightly stack with headed browsers (xvfb-run on Linux).
const hiddenMs = 315_000;
const receiveMs = 8_000;
const runId = `listen-only-${randomUUID()}`;
const directory = resolve(process.env.CHALK_LISTEN_ONLY_DIRECTORY ?? `.private/web-proof/${runId}`);
const report = {};
const browsers = [];
let run;
let failed = false;
try {
  assert.equal(process.env.CHALK_PROOF_CONFIG_SOURCE, "env");
  for (const name of ["CHALK_PROOF_API_URL", "CHALK_PROOF_WEB_URL"]) {
    assert.equal(new URL(process.env[name]).hostname, "127.0.0.1", "Use the throwaway loopback stack");
  }
  // Own a fresh Space so cleanup never changes a shared invite.
  assert.ok(!process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU && process.env.CHALK_PROOF_SPACE_BY_SLUG !== "true");
  const config = await loadConfig({ capabilities: false });
  run = await createRun(config, directory, undefined, runId);
  await prepareIntegration(run, false);
  const space = await createSpace(run, "chalk_sfu");
  await run.apiRequest("POST", `${run.tenantPath}/spaces/${space.id}/episodes`, { metadata: { proof_run_id: runId } });
  const invite = await run.ownerRequest("PATCH", `${run.tenantPath}/spaces/${space.id}/public-invite`, { enabled: true });
  const url = new URL(invite.canonical_url);
  maskCredentials({ inviteToken: url.hash.slice(1), canonicalCredential: invite.canonical_url });
  const entry = new URL(url.pathname + url.search + url.hash, config.web_url).href;
  const [edge, safari] = await Promise.all([
    launch(chromium, {
      channel: process.env.CHALK_PROOF_CHROMIUM_CHANNEL,
      ignoreDefaultArgs: ["--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
    }),
    launch(webkit, {}),
  ]);
  const listeners = await Promise.all([
    join(edge, entry, "Chromium listener", 1),
    join(safari, entry, "WebKit listener", 2, devices["iPad Pro 11"]),
  ]);
  await Promise.all(listeners.map(checkEmptyJoin));
  await Promise.all(listeners.map(backgroundThroughRefresh));
  const publisher = await join(edge, entry, "Publisher", 3);
  await control(publisher.page, "Unmute microphone");
  await control(publisher.page, "Turn on camera");
  await Promise.all(listeners.map(checkDelivery));
  failed = listeners.some(({ evidence }) => Object.values(evidence.journeys).some((passed) => !passed));
} catch (error) {
  failed = true;
  // Locator errors may include an invite URL. Save the step results, not raw errors.
  report.error = error.name;
} finally {
  await Promise.allSettled(browsers.map((browser) => browser.close()));
  if (run) {
    try {
      await cleanupRun(run);
      report.cleanup = "passed";
    } catch {
      report.cleanup = "failed";
      failed = true;
    }
    await save(`${directory}/listen-only-report.json`, { ...report, result: failed ? "failed" : "passed" });
  }
}
console.log(`Listen-only proof ${failed ? "failed" : "passed"}: ${directory}/listen-only-report.json`);
process.exitCode = failed ? 1 : 0;

async function launch(engine, options) {
  const browser = await engine.launch({ headless: false, ...options });
  browsers.push(browser);
  return browser;
}

async function join(browser, entry, name, fixture, device) {
  const context = await browser.newContext(device);
  await context.addInitScript(webMediaFixture(fixture, { permission: "granted" }));
  await context.addInitScript(() => {
    window.proofReconnected = false;
    window.proofVisibility = [];
    document.addEventListener("visibilitychange", () => window.proofVisibility.push(document.visibilityState));
    new MutationObserver(() => {
      if (document.querySelector('[data-part="connection-status"]')) window.proofReconnected = true;
    }).observe(document, { childList: true, subtree: true });
  });
  const page = await context.newPage();
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
    responses.push(response.json().then((body) => {
      const media = (refresh ? body : body.access)?.media;
      if (arrival && media && !initialBinding) {
        initialBinding = media.client_payload.connectionId;
        initialExpiry = media.expires_at;
      }
      if (refresh) evidence.refreshes.push({
        status: response.status(),
        sameBinding: initialBinding !== undefined && media?.client_payload.connectionId === initialBinding,
        extendedExpiry: initialExpiry !== undefined && media?.expires_at > initialExpiry,
      });
      const code = body.error?.code ?? body.code;
      if (code === "media.connection_not_found" || code === "access.media_proof_expired") evidence.mediaErrors.push(code);
    }).catch(() => {}));
  });
  await page.goto(entry);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join call", exact: true }).click();
  await page.getByRole("region", { name: "Space stage", exact: true }).waitFor({ timeout: 30_000 });
  return { name, page, context, evidence, responses };
}

async function checkEmptyJoin({ page, name, evidence }) {
  await control(page, "Unmute microphone", { waitOnly: true });
  await control(page, "Turn on camera", { waitOnly: true });
  evidence.emptyConnected = await waitFor(page, () => {
    const [peer] = window.proofConnections;
    return peer?.connectionState === "connected" && peer.getSenders().every((sender) => sender.track === null);
  }, receiveMs);
  await page.screenshot({ path: `${directory}/${name}-joined.png` });
}

async function backgroundThroughRefresh({ page, context, name, evidence, responses }) {
  const cover = await context.newPage();
  await cover.bringToFront();
  evidence.wentHidden = await waitFor(page, () => document.hidden, 5_000);
  const started = Date.now();
  console.log(`${name}: empty transport connected=${evidence.emptyConnected}, hidden=${evidence.wentHidden}`);
  await delay(hiddenMs);
  await page.bringToFront();
  const foreground = await waitFor(page, () => !document.hidden, 5_000);
  await cover.close();
  await Promise.all(responses);
  const state = await page.evaluate(() => ({
    peerStates: window.proofConnections.map((peer) => peer.connectionState),
    reconnected: window.proofReconnected,
    continuouslyHidden: window.proofVisibility.slice(-2).join(",") === "hidden,visible",
  }));
  evidence.hiddenDurationMs = Date.now() - started;
  Object.assign(evidence, state);
  evidence.journeys.background = evidence.wentHidden && state.continuouslyHidden && foreground && !state.reconnected && state.peerStates.join() === "connected";
  evidence.journeys.refresh = evidence.refreshes.some(({ status, sameBinding, extendedExpiry }) => status === 201 && sameBinding && extendedExpiry) && evidence.mediaErrors.length === 0;
  await page.screenshot({ path: `${directory}/${name}-returned.png` });
}

async function checkDelivery({ page, name, evidence, responses }) {
  const started = Date.now();
  const media = await waitFor(page, async () => {
    const [peer, ...replacements] = window.proofConnections;
    if (!peer || replacements.length || peer.connectionState !== "connected") return false;
    const reports = [...(await peer.getStats()).values()];
    const audio = reports.some((row) => row.type === "inbound-rtp" && (row.kind ?? row.mediaType) === "audio" && row.packetsReceived > 5);
    const video = document.querySelector('[aria-label="Video tile for Publisher"]')?.closest('[data-part="stage-tile"]')?.querySelector("video");
    return audio && video?.readyState >= 2 && video.getVideoPlaybackQuality().totalVideoFrames > 5;
  }, receiveMs);
  await Promise.all(responses);
  evidence.mediaAfterPublishMs = media ? Date.now() - started : null;
  evidence.journeys.latePublisher = evidence.emptyConnected && media && evidence.mediaErrors.length === 0;
  await page.screenshot({ path: `${directory}/${name}-publisher.png` });
}

async function waitFor(page, predicate, timeout) {
  try {
    await page.waitForFunction(predicate, undefined, { timeout, polling: 100 });
    return true;
  } catch (error) {
    if (error.name !== "TimeoutError") throw error;
    return false;
  }
}

async function control(page, name, { waitOnly = false } = {}) {
  await page.getByRole("region", { name: "Space stage", exact: true }).hover();
  const button = page.getByRole("button", { name, exact: true });
  if (waitOnly) await button.waitFor({ timeout: 10_000 });
  else await button.click({ timeout: 10_000 });
}
