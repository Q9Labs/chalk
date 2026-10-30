// Isolated local API + Sync, with a dedicated development SFU application.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor } from "./chalk.mjs";

// Run with CHALK_DEVICE_PROOF_SCENARIO=cold for the fresh, pending-seat outage.
// The default run covers the call UI and a Sync outage with subscribed audio.
const coldOnly = process.env.CHALK_DEVICE_PROOF_SCENARIO === "cold";
const root = process.cwd();
const requireClient = createRequire(resolve("sdks/typescript/client/package.json"));
const requireWeb = createRequire(resolve("apps/web/package.json"));
const { chromium } = requireClient("playwright");
const { build } = requireClient("esbuild");
const { build: viteBuild } = await import(pathToFileURL(requireWeb.resolve("vite")));
const { default: tailwind } = await import(pathToFileURL(requireWeb.resolve("@tailwindcss/vite")));
const output = resolve("artifacts/multi-device");
await mkdir(output, { recursive: true });
const credentials = JSON.parse(await readFile(process.env.CHALK_DEVICE_SFU_FILE, "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);
const config = resolveDevConfig({ root, env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "300000", CHALK_DEV_WEB_PORT: "4870" }, requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"], secretResolver: async () => credentials });
let systemToken;
let tenant;
let space;
const localFetch = async (input, init) => {
  const url = new URL(input);
  assert.equal(url.hostname, "127.0.0.1");
  systemToken ??= new Headers(init?.headers).get("Authorization")?.slice(7);
  const response = await fetch(input, init);
  if (response.ok) {
    const body = await response
      .clone()
      .json()
      .catch(() => undefined);
    if (url.pathname === "/v1/tenants") tenant = init?.method === "POST" ? body : body.tenants?.find((entry) => entry.name.startsWith("Chalk local dev "));
    if (/\/spaces$/u.test(url.pathname)) space = init?.method === "POST" ? body : body.spaces?.find((entry) => entry.slug.startsWith("chalk-local-"));
  }
  return response;
};
const services = [
  { id: "api", command: "go", expectedCommand: null, args: ["run", "./cmd"], cwd: `${root}/apps/api`, readiness: { url: `${config.urls.api}/readyz` } },
  { id: "sync", command: "mix", expectedCommand: null, args: ["run", "--no-halt"], cwd: `${root}/apps/sync`, dependsOn: ["api"], readiness: { url: `${config.urls.sync}/readyz` } },
];
const runtime = createChalkSupervisor({ ...config, webJoinPath: "/" }, { serviceSpecs: services, adapters: { fetchImpl: localFetch }, output: () => undefined });
const report = { stack: "isolated local API and Sync with development SFU", assertions: [] };
const alias = Object.fromEntries(
  [
    ["react-dom", resolve(requireWeb.resolve("react-dom/package.json"), "..")],
    ["react", resolve(requireWeb.resolve("react/package.json"), "..")],
    ["@q9labsai/chalk-client/effect", "sdks/typescript/client/src/effect.ts"],
    ["@q9labsai/chalk-client", "sdks/typescript/client/src/index.ts"],
    ["@q9labsai/chalk-ui/reactions", "packages/ui/src/reactions.ts"],
    ["@q9labsai/chalk-ui/assets", "packages/ui/src/assets.ts"],
    ["@q9labsai/chalk-ui/button", "packages/ui/src/button.tsx"],
    ["@q9labsai/chalk-ui", "packages/ui/src/index.ts"],
    ["@q9labsai/chalk-assets", "packages/assets/src/index.ts"],
    ["@q9labsai/chalk-whiteboard/react", "packages/whiteboard/src/react/index.ts"],
    ["@q9labsai/chalk-whiteboard", "packages/whiteboard/src/index.ts"],
    ["@q9labsai/facehash/react", "packages/facehash/src/react.ts"],
    ["@q9labsai/facehash", "packages/facehash/src/index.ts"],
  ].map(([name, path]) => [name, resolve(path)]),
);
await build({
  stdin: {
    contents: `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {createSpaceClientForPlatform} from './sdks/typescript/client/src/space-client/space-client.ts';
import {Chalk} from './sdks/typescript/react/src/components/chalk/Chalk.tsx';
window.startDevice = (space, baseUrl, syncUrl, name) => {
  window.client = createSpaceClientForPlatform({space, baseUrl, getAccess: () => window.proofAccess()}, {syncUrl});
  createRoot(document.getElementById('root')).render(React.createElement(Chalk, {client: window.client, displayName: name, spaceName: 'Multi-device classroom', defaults: {microphone:true, camera:false}, features: {whiteboard:false, sounds:false, recording:false}}));
};`,
    resolveDir: root,
    loader: "tsx",
  },
  bundle: true,
  outfile: `${output}/bundle.js`,
  platform: "browser",
  format: "iife",
  alias,
  loader: { ".css": "empty", ".woff2": "dataurl", ".svg": "dataurl" },
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(`${output}/styles.css`, `@import "${root}/packages/ui/src/styles/index.css";\n@source "${root}/sdks/typescript/react/src";\n@source "${root}/packages/ui/src";\nhtml,body,#root{height:100%;margin:0;font-family:Inter,Arial,sans-serif}`);
await writeFile(`${output}/index.html`, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body><div id="root"></div><script type="module" src="/bundle.js"></script></body></html>');
await viteBuild({ root: output, configFile: false, plugins: [tailwind()], logLevel: "warn", build: { outDir: "static", emptyOutDir: true } });
await build({ entryPoints: ["sdks/typescript/client/src/server/index.ts"], bundle: true, outfile: `${output}/server.mjs`, platform: "node", format: "esm" });
const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(`${output}/server.mjs`));
let server;
const blockedSyncHandshakes = new Set();
let browser;
let chalk;
let episode;
const pages = [];
let previousEntryEnforcement;
const localSQL = (sql) => execFileSync("docker", ["exec", config.postgres.container, "psql", "-U", "postgres", "-d", config.databaseName, "-Atqc", sql], { encoding: "utf8" }).trim();
async function freezeReview(page, name) {
  let css = await page.evaluate(() => [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText)).join("\n"));
  for (const match of css.matchAll(/url\((["']?)(\/assets\/[^)"']+)\1\)/g)) {
    const data = await readFile(`${output}/static${match[2]}`);
    const mime = match[2].endsWith(".woff2") ? "font/woff2" : "image/svg+xml";
    css = css.replaceAll(match[0], `url("data:${mime};base64,${data.toString("base64")}")`);
  }
  const html = await page.evaluate((css) => {
    const frozen = document.documentElement.cloneNode(true);
    frozen.querySelectorAll("script,link").forEach((element) => element.remove());
    const style = document.createElement("style");
    style.textContent = css;
    frozen.querySelector("head").append(style);
    return `<!doctype html>${frozen.outerHTML}`;
  }, css);
  await writeFile(`${output}/${name}.html`, html);
}
try {
  report.stage = "local stack";
  await runtime.start();
  assert.ok(tenant && space && systemToken);
  previousEntryEnforcement = localSQL("select row_to_json(rollout) from sync_entry_rollout rollout where singleton");
  localSQL("update sync_entry_rollout set enforced=true,enforced_at=now(),release_id='multi-device-local-proof' where singleton");
  report.admissionEnforced = true;
  chalk = createChalkServerClient({ apiBaseURL: config.urls.api, tenantId: tenant.id, apiKey: systemToken });
  episode = await chalk.episodes.create(space.id, {});
  const assets = new Map();
  for (const entry of await readdir(`${output}/static/assets`, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    assets.set(`/assets/${entry.name}`, { content: await readFile(`${output}/static/assets/${entry.name}`), type: extname(entry.name) === ".css" ? "text/css" : extname(entry.name) === ".js" ? "text/javascript" : "application/octet-stream" });
  }
  assets.set("/", { content: await readFile(`${output}/static/index.html`), type: "text/html" });
  server = createServer((request, response) => {
    const asset = assets.get(request.url);
    if (!asset) return response.writeHead(404).end();
    response.setHeader("Content-Type", asset.type);
    response.end(asset.content);
  });
  // A dropped Sync connection gets a pending network handshake, not an immediate
  // constructor error that would spend the retry budget before the phone joins.
  server.on("upgrade", (_request, socket) => {
    blockedSyncHandshakes.add(socket);
    socket.on("close", () => blockedSyncHandshakes.delete(socket));
  });
  server.listen(config.ports.web, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ channel: "chromium", headless: true, args: ["--disable-audio-output", "--autoplay-policy=no-user-gesture-required"] });
  const admissions = [];
  for (const [index, name, identityExternalId, role] of [
    [0, "Teacher", "person-teacher", "owner"],
    [1, "Teacher", "person-teacher", "owner"],
    [2, "Learner", "person-learner", "collaborator"],
  ]) {
    report.stage = `join ${index}`;
    const admission = await chalk.participants.admit(space.id, episode.id, { name, role, identityExternalId });
    admissions.push(admission);
    let grant = admission.access;
    let first = true;
    const context = await browser.newContext({
      viewport: index === 1 ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      permissions: ["microphone", "camera"],
      ...(index === 1 ? { isMobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" } : {}),
    });
    await context.addInitScript(() => {
      window.playedAudioTracks = [];
      window.proofSyncSockets = [];
      window.proofWelcomes = [];
      window.proofMediaSnapshots = [];
      window.proofBlockSync = false;
      const NativeWebSocket = window.WebSocket;
      window.WebSocket = class extends NativeWebSocket {
        constructor(url, protocols) {
          const sync = new URL(url, location.href).pathname === "/v1/sync";
          const target = sync && window.proofBlockSync ? `ws://${location.host}/blocked-sync` : url;
          super(target, protocols);
          if (sync) {
            window.proofSyncSockets.push(this);
            this.addEventListener("message", (event) => {
              const frame = JSON.parse(event.data);
              if (frame.type === "welcome")
                window.proofWelcomes.push({ ownIdentityPresent: typeof frame.participant_identity_id === "string", ownSeatAdmitted: frame.snapshot?.participants.some((seat) => seat.participant_id === frame.participant_id), entryConfirmation: frame.entry_confirmation === true });
              if (frame.stream === "media") window.proofMediaSnapshots.push(frame);
            });
          }
        }
      };
      window.proofPeerConnections = [];
      const NativePeerConnection = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends NativePeerConnection {
        constructor(configuration) {
          super(configuration);
          window.proofPeerConnections.push(this);
        }
      };
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        for (const track of this.srcObject?.getAudioTracks?.() ?? []) window.playedAudioTracks.push(track.id);
        return play.call(this);
      };
      navigator.mediaDevices.getUserMedia = async () => {
        const audio = new AudioContext();
        const oscillator = audio.createOscillator();
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(destination);
        oscillator.start();
        await audio.resume();
        return destination.stream;
      };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        canvas.getContext("2d").fillRect(0, 0, 640, 360);
        const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
        return new MediaStream([...canvas.captureStream(5).getVideoTracks(), ...audio.getAudioTracks()]);
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => {
      report.browserError = error.message.slice(0, 500);
    });
    pages.push(page);
    await page.exposeFunction("proofAccess", async () => {
      if (first) {
        first = false;
        return grant;
      }
      grant = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(grant));
      return grant;
    });
    await page.goto(config.urls.web);
    await page.waitForFunction(() => typeof window.startDevice === "function");
    if (coldOnly && index === 1) {
      await pages[0].evaluate(() => {
        window.proofBlockSync = true;
        for (const socket of window.proofSyncSockets) if (socket.readyState === WebSocket.OPEN) socket.close(4000, "proof cold-join Sync outage");
      });
      await pages[0].waitForFunction(() => window.proofSyncSockets.some((socket) => socket.readyState === WebSocket.CLOSED));
    }
    await page.evaluate(({ slug, api, sync, name }) => window.startDevice(slug, api, sync, name), { slug: space.slug, api: config.urls.api, sync: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name });
    await page.waitForFunction(() => window.client?.getSnapshot().connection.status === "live", undefined, { timeout: 60000 });
    // Entry confirmation follows media startup. Wait for the admitted roster and
    // its capabilities before exercising controls that require a confirmed seat.
    await page.waitForFunction(
      () => {
        const snapshot = client.getSnapshot();
        return snapshot.connection.status === "live" && snapshot.self.can("publishAudio") && snapshot.participants.roster.find((seat) => seat.participantId === snapshot.self.participantId)?.presence.state === "connected";
      },
      undefined,
      { timeout: 60000 },
    );
    if (index === 0) {
      await page.waitForFunction(() => client.getSnapshot().media.local.microphone.state === "enabled");
      await page.screenshot({ path: `${output}/before-desktop.png` });
      if (coldOnly) {
        // Keep the SFU publications alive before a completely fresh phone joins.
        await page.evaluate(() => client.media.setScreenShareEnabled(true, { audio: true }));
        await page.waitForFunction(() => client.getSnapshot().media.screenShare.hasAudio);
        report.desktopBeforeOutage = await page.evaluate(() => ({ microphone: client.getSnapshot().media.local.microphone.state, screenAudio: client.getSnapshot().media.screenShare.hasAudio }));
      }
    }
    if (coldOnly && index === 1) {
      report.stage = "fresh phone during desktop Sync outage";
      const desktopId = admissions[0].participant.id;
      report.pendingAdmission = await page.evaluate(() => window.proofWelcomes[0]);
      assert.deepEqual(report.pendingAdmission, { ownIdentityPresent: true, ownSeatAdmitted: false, entryConfirmation: true });
      await page.waitForFunction((id) => window.proofMediaSnapshots.some((frame) => ["microphone", "screen"].every((source) => frame.items?.some((item) => item.participant_id === id && item.source === source && item.enabled))), desktopId, { timeout: 30000 });
      const cold = await page.evaluate((id) => {
        const snapshot = client.getSnapshot();
        const sibling = snapshot.participants.roster.find((item) => item.participantId === id);
        const self = snapshot.participants.roster.find((item) => item.participantId === snapshot.self.participantId);
        const ownTracks = snapshot.media.remote.filter((item) => item.participantId === id);
        return {
          desktopPresence: sibling?.presence.state,
          identityMatched: !!self?.identityId && sibling?.identityId === self.identityId,
          deviceType: sibling?.deviceType,
          microphoneState: snapshot.media.local.microphone.state,
          microphoneMutedByOtherDevice: snapshot.media.microphoneMutedByOtherDevice,
          microphonePlays: ownTracks.filter((item) => item.source === "microphone" && window.playedAudioTracks.includes(item.track.id)).length,
          sharedAudioPlays: ownTracks.filter((item) => item.source === "screen_audio" && window.playedAudioTracks.includes(item.track.id)).length,
          subscribedAudioTracks: ownTracks.filter((item) => ["microphone", "screen_audio"].includes(item.source)).length,
        };
      }, desktopId);
      assert.equal(cold.desktopPresence, "disconnected");
      assert.equal(cold.identityMatched, true);
      assert.equal(cold.deviceType, "computer");
      assert.equal(cold.microphoneState, "disabled");
      assert.equal(cold.microphoneMutedByOtherDevice, true);
      assert.equal(cold.microphonePlays, 0);
      assert.equal(cold.sharedAudioPlays, 0);
      report.coldJoinDuringSyncOutage = cold;
      report.assertions.push("desktop Sync socket closes before a fresh phone joins: phone mic off, zero desktop mic/shared-audio playback calls");
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
      await page.waitForFunction(() => document.querySelectorAll(".chalk-toast").length === 0);
      // Capture normal pointer interaction without disabling keyboard focus styling.
      await page.locator('[data-part="header-region"]').click({ position: { x: 280, y: 20 } });
      await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running" || animation.effect?.getComputedTiming().iterations === Infinity));
      await page.screenshot({ path: `${output}/cold-join-phone.png` });
      await pages[0].evaluate(() => {
        window.proofBlockSync = false;
        for (const socket of window.proofSyncSockets) if (socket.readyState === WebSocket.CONNECTING) socket.close();
      });
      break;
    }
  }
  if (coldOnly) {
    report.stage = "complete";
  } else {
    const [desktop, phone, learner] = pages;
    assert.ok(admissions[0].participant.identity_id);
    assert.equal(admissions[0].participant.identity_id, admissions[1].participant.identity_id);
    assert.notEqual(admissions[0].participant.id, admissions[1].participant.id);
    await phone.getByText("Mic off: your other device is using it.", { exact: true }).waitFor();
    assert.equal(await phone.evaluate(() => client.getSnapshot().media.local.microphone.state), "disabled");
    for (const page of [desktop, phone]) assert.equal(await page.evaluate(() => client.getSnapshot().self.can("muteOthers")), true);
    report.assertions.push("separate seats share one identity", "new phone microphone starts off with an explanation", "teacher rights on both devices");
    await desktop.waitForFunction(() => client.getSnapshot().participants.roster.filter((item) => item.displayName === "Teacher" && item.presence.state === "connected").length === 2);
    for (const page of [desktop, phone]) await page.waitForFunction(() => ![...document.querySelectorAll(".chalk-toast")].some((item) => item.textContent.includes("joined")));
    for (const [page, ownDeviceId] of [
      [desktop, admissions[1].participant.id],
      [phone, admissions[0].participant.id],
    ]) {
      await page.waitForFunction((id) => document.querySelector('[data-stage-role="primary"]')?.getAttribute("data-stage-item") === id, admissions[2].participant.id);
      const ids = await page.locator("[data-stage-item]").evaluateAll((items) => items.map((item) => item.getAttribute("data-stage-item")));
      assert.equal(ids.at(-1), ownDeviceId);
      assert.equal(
        await page
          .locator(`[data-stage-item="${ownDeviceId}"] [data-part="tile-full-name"] > span`)
          .first()
          .evaluate((name) => name.scrollWidth <= name.clientWidth),
        true,
      );
    }
    assert.equal(
      await desktop.locator('[data-part="tile-self-label"]').evaluate((label) => {
        const rect = label.getBoundingClientRect();
        const chip = label.closest('[data-part="tile-tag"]').getBoundingClientRect();
        return label.textContent.trim() === "(You)" && rect.width > 0 && rect.left >= chip.left && rect.right <= chip.right && label.scrollWidth <= label.clientWidth;
      }),
      true,
    );
    report.assertions.push("learner leads the stage on desktop and phone; own devices come last", "desktop self label keeps (You) visible");
    await desktop.screenshot({ path: `${output}/after-desktop.png` });
    await phone.screenshot({ path: `${output}/after-phone.png` });
    await freezeReview(desktop, "review-desktop");
    await freezeReview(phone, "review-phone");
    await desktop.getByRole("button", { name: "People, 3", exact: true }).click();
    await desktop.getByRole("region", { name: "People", exact: true }).waitFor();
    await desktop.screenshot({ path: `${output}/roster-desktop.png` });
    await freezeReview(desktop, "review-roster");
    await desktop.getByRole("button", { name: "People, 3", exact: true }).click();
    report.stage = "moderation";
    for (const teacher of [desktop, phone]) {
      await learner.evaluate(() => client.media.setMicrophoneEnabled(true));
      await teacher.evaluate((id) => client.participants.mute(id), admissions[2].participant.id);
      await learner.waitForFunction(() => client.getSnapshot().media.local.microphone.state === "disabled");
    }
    await learner.evaluate(() => client.media.setMicrophoneEnabled(true));
    report.stage = "audio playback";
    await phone.evaluate(() => client.media.setMicrophoneEnabled(true));
    for (const teacher of [desktop, phone]) {
      await teacher.waitForFunction((id) => client.getSnapshot().media.remote.some((item) => item.participantId === id && item.source === "microphone" && window.playedAudioTracks.includes(item.track.id)), admissions[2].participant.id, { timeout: 60000 });
      assert.equal(
        await teacher.evaluate(() => {
          const snapshot = client.getSnapshot();
          const identityId = snapshot.participants.roster.find((item) => item.participantId === snapshot.self.participantId)?.identityId;
          const ownIds = new Set(snapshot.participants.roster.filter((item) => item.identityId === identityId).map((item) => item.participantId));
          return snapshot.media.remote.filter((item) => ownIds.has(item.participantId) && window.playedAudioTracks.includes(item.track.id)).length;
        }),
        0,
      );
    }
    report.assertions.push("both teachers mute the learner", "other-person audio plays on both devices", "no self audio plays after explicitly enabling the phone mic");
    report.stage = "Sync-only disconnect";
    await desktop.evaluate(() => client.media.setScreenShareEnabled(true, { audio: true }));
    await phone.waitForFunction((id) => ["microphone", "screen_audio"].every((source) => client.getSnapshot().media.remote.some((item) => item.participantId === id && item.source === source && item.track.readyState === "live")), admissions[0].participant.id, { timeout: 60000 });
    const inboundAudio = async (page, id) =>
      page.evaluate(async (id) => {
        const ids = new Set(
          client
            .getSnapshot()
            .media.remote.filter((item) => item.participantId === id && ["microphone", "screen_audio"].includes(item.source))
            .map((item) => item.track.id),
        );
        const reports = await Promise.all(window.proofPeerConnections.map((pc) => pc.getStats()));
        return reports
          .flatMap((report) => [...report.values()])
          .filter((item) => item.type === "inbound-rtp" && ids.has(item.trackIdentifier))
          .map((item) => ({ id: item.trackIdentifier, bytes: item.bytesReceived }));
      }, id);
    const inboundBefore = await inboundAudio(phone, admissions[0].participant.id);
    assert.equal(inboundBefore.length, 2);
    await desktop.evaluate(() => {
      window.proofBlockSync = true;
      for (const socket of window.proofSyncSockets) if (socket.readyState === WebSocket.OPEN) socket.close(4000, "proof Sync-only disconnect");
    });
    await phone.waitForFunction((id) => client.getSnapshot().participants.roster.some((item) => item.participantId === id && item.presence.state !== "connected"), admissions[0].participant.id);
    await phone.waitForFunction(
      async ({ id, before }) => {
        const ids = new Set(
          client
            .getSnapshot()
            .media.remote.filter((item) => item.participantId === id)
            .map((item) => item.track.id),
        );
        const reports = await Promise.all(window.proofPeerConnections.map((pc) => pc.getStats()));
        const received = reports.flatMap((report) => [...report.values()]).filter((item) => item.type === "inbound-rtp" && ids.has(item.trackIdentifier));
        return before.every((previous) => received.some((item) => item.trackIdentifier === previous.id && item.bytesReceived > previous.bytes));
      },
      { id: admissions[0].participant.id, before: inboundBefore },
      { timeout: 15000 },
    );
    const disconnect = await phone.evaluate((id) => {
      const snapshot = client.getSnapshot();
      const sibling = snapshot.participants.roster.find((item) => item.participantId === id);
      const ownTracks = snapshot.media.remote.filter((item) => item.participantId === id);
      return {
        identityRetained: sibling?.identityId === snapshot.participants.roster.find((item) => item.participantId === snapshot.self.participantId)?.identityId,
        deviceType: sibling?.deviceType,
        microphonePlays: ownTracks.filter((item) => item.source === "microphone" && window.playedAudioTracks.includes(item.track.id)).length,
        sharedAudioPlays: ownTracks.filter((item) => item.source === "screen_audio" && window.playedAudioTracks.includes(item.track.id)).length,
      };
    }, admissions[0].participant.id);
    assert.equal(disconnect.identityRetained, true);
    assert.equal(disconnect.deviceType, "computer");
    assert.equal(disconnect.microphonePlays, 0);
    assert.equal(disconnect.sharedAudioPlays, 0);
    report.syncOnlyDisconnect = { ...disconnect, inboundAudioContinued: true };
    report.assertions.push("phone stays silent for the desktop microphone and shared audio through desktop Sync-only loss while both SFU audio streams keep receiving packets");
    await phone.screenshot({ path: `${output}/sync-disconnect-phone.png` });
    await desktop.evaluate(() => {
      window.proofBlockSync = false;
      for (const socket of window.proofSyncSockets) if (socket.readyState === WebSocket.CONNECTING) socket.close();
    });
    await desktop.waitForFunction(() => client.getSnapshot().connection.status === "live", undefined, { timeout: 60000 });
    await phone.waitForFunction((id) => client.getSnapshot().participants.roster.find((item) => item.participantId === id)?.presence.state === "connected", admissions[0].participant.id);
    await desktop.evaluate(() => client.media.setScreenShareEnabled(false));
    report.stage = "phone leave";
    await phone.getByRole("button", { name: "Leave call", exact: true }).click();
    await phone.getByRole("menuitem", { name: "Leave call", exact: true }).click();
    await phone.waitForFunction(() => client.getSnapshot().connection.status === "left");
    await desktop.waitForFunction((id) => !client.getSnapshot().participants.roster.some((item) => item.participantId === id), admissions[1].participant.id);
    assert.equal(await desktop.evaluate(() => client.getSnapshot().connection.status), "live");
    assert.equal(await desktop.evaluate(() => client.getSnapshot().media.local.microphone.state), "enabled");
    await desktop.getByText("Phone · 2 devices", { exact: true }).waitFor({ state: "hidden" });
    await desktop.waitForFunction(() => ![...document.querySelectorAll(".chalk-toast")].some((item) => item.textContent.includes("left")));
    await desktop.screenshot({ path: `${output}/after-phone-left-desktop.png` });
    await phone.screenshot({ path: `${output}/after-phone-left-phone.png` });
    report.assertions.push("phone Leave keeps the desktop live with microphone enabled");
    const sheet = await browser.newPage({ viewport: { width: 1860, height: 2010 } });
    const data = async (name) => `data:image/png;base64,${(await readFile(`${output}/${name}.png`)).toString("base64")}`;
    await sheet.setContent(
      `<html><body style="margin:0;padding:24px;background:#edf0f4;font:20px Arial;color:#192438"><h1>One person, two devices</h1><p>Real Chromium contexts · local API + Sync · development SFU</p><div style="display:grid;grid-template-columns:1390px 390px;gap:24px"><section><h2>Before: desktop alone</h2><img width="1390" src="${await data("before-desktop")}"><h2>After: both devices live</h2><img width="1390" src="${await data("after-desktop")}"></section><section><h2>New phone</h2><img width="390" src="${await data("after-phone")}"><h2>Phone left</h2><img width="390" src="${await data("after-phone-left-phone")}"></section><section><h2>Phone Leave: desktop stays live</h2><img width="1390" src="${await data("after-phone-left-desktop")}"></section></div></body></html>`,
    );
    await sheet.screenshot({ path: `${output}/contact-sheet.png`, fullPage: true });
    report.stage = "complete";
  }
} catch (error) {
  report.error = error.message;
  report.pages = await Promise.all(
    pages.map(async (page, index) => {
      await page.screenshot({ path: `${output}/failure-${index}.png` });
      return page.evaluate(() => ({
        connection: window.client?.getSnapshot().connection,
        media: { local: window.client?.getSnapshot().media.local.microphone.state, remote: window.client?.getSnapshot().media.remote.map((item) => ({ participantId: item.participantId, source: item.source, enabled: item.track.enabled, readyState: item.track.readyState })) },
        welcomes: window.proofWelcomes,
        projections: window.proofMediaSnapshots.slice(-4),
        text: document.body.innerText.slice(0, 1200),
      }));
    }),
  );
  throw error;
} finally {
  for (const page of pages)
    await page
      .evaluate(async () => {
        await window.client?.leave();
        window.client?.dispose();
      })
      .catch(() => undefined);
  if (browser) await browser.close();
  if (episode && chalk) await chalk.episodes.end(space.id, episode.id).catch(() => undefined);
  for (const socket of blockedSyncHandshakes) socket.destroy();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (previousEntryEnforcement) localSQL(`update sync_entry_rollout set (enforced,enforced_at,release_id)=(select enforced,enforced_at,release_id from json_populate_record(null::sync_entry_rollout, '${previousEntryEnforcement.replaceAll("'", "''")}'::json)) where singleton`);
  await runtime.stop();
  await writeFile(`${output}/${coldOnly ? "cold-report" : "report"}.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
