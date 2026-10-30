// Run on Instabox with a dedicated development SFU application, never production.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDevConfig } from "./config.mjs";
import { createChalkSupervisor } from "./chalk.mjs";

const requireClient = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url));
const { chromium } = requireClient("playwright");
const { build } = requireClient("esbuild");
const root = process.cwd();
const output = resolve("artifacts/camera-backgrounds-sfu");
await mkdir(output, { recursive: true });
// The caller supplies this private file over SSH stdin, outside the source snapshot.
const credentials = JSON.parse(await readFile("/tmp/chalk-camera-development.json", "utf8"));
assert.equal(credentials.environment, "development");
assert.equal(credentials.source, "chalk-local-dev");
assert.ok(credentials.appId && credentials.appSecret);
let systemToken;
let tenant;
let space;
const config = { ...resolveDevConfig({ root, env: { ...process.env, CHALK_DEV_READINESS_TIMEOUT_MS: "300000", CHALK_DEV_WEB_PORT: "4870" }, requiredTools: ["node", "pnpm", "go", "elixir", "erl", "docker", "openssl"], secretResolver: async () => credentials }), webJoinPath: "/space" };
const services = [
  { id: "api", command: "go", expectedCommand: null, args: ["run", "./cmd"], cwd: `${root}/apps/api`, readiness: { url: `${config.urls.api}/readyz` } },
  { id: "sync", command: "mix", expectedCommand: null, args: ["run", "--no-halt"], cwd: `${root}/apps/sync`, dependsOn: ["api"], readiness: { url: `${config.urls.sync}/readyz` } },
];
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
const runtime = createChalkSupervisor(config, { serviceSpecs: services, adapters: { fetchImpl: localFetch }, output: () => undefined });
let server;
let chalk;
let episode;
const browsers = [];
const pages = [];
const report = { stack: "local API + Sync, dedicated development Cloudflare SFU", assertions: [] };

const browserBundle = await build({
  stdin: {
    contents: `
import {syntheticCamera} from './apps/web/src/call-states/camera-fixtures/synthetic-camera.ts';
import {createSpaceClientForPlatform} from './sdks/typescript/client/src/effect.ts';
import {configureCameraEffects} from './sdks/typescript/client/src/camera-effects.ts';
import {setCameraBackground} from './sdks/typescript/client/src/media/camera-effects.ts';
import {CAMERA_VISION_ROOT,CAMERA_SEGMENTATION_MODEL} from './apps/web/src/lib/camera-effect-assets.ts';
configureCameraEffects({wasmRoot:location.origin+CAMERA_VISION_ROOT,modelUrl:location.origin+CAMERA_SEGMENTATION_MODEL});
navigator.mediaDevices.getUserMedia=async()=>{const image=new Image();image.src='/portrait.jpg';await image.decode();window.synthetic=syntheticCamera(image,640);return new MediaStream([window.synthetic.track]);};
window.changeBackground = (value) => setCameraBackground('proof-camera',value);
window.joinProof=async(space,baseUrl,syncUrl,name,camera)=>{window.client=createSpaceClientForPlatform({space,baseUrl,getAccess:()=>window.proofAccess()},{syncUrl});await client.join({displayName:name,microphone:false,camera});};
`,
    resolveDir: root,
    sourcefile: "camera-background-proof.ts",
  },
  bundle: true,
  write: false,
  platform: "browser",
  format: "iife",
});
await build({ entryPoints: ["sdks/typescript/client/src/server/index.ts"], bundle: true, outfile: `${output}/server.mjs`, platform: "node", format: "esm" });
const { createChalkServerClient, getAccessRefreshState } = await import(pathToFileURL(`${output}/server.mjs`).href);
try {
  report.stage = "start local stack";
  console.log(report.stage);
  await runtime.start();
  assert.equal(runtime.status().state, "ready");
  assert.ok(tenant && space && systemToken, "isolated bootstrap required");
  chalk = createChalkServerClient({ apiBaseURL: config.urls.api, tenantId: tenant.id, apiKey: systemToken });
  episode = await chalk.episodes.create(space.id, {});
  server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, "http://localhost").pathname;
      if (path.startsWith("/camera-effects/") && !path.includes("..")) {
        response.setHeader("Content-Type", path.endsWith(".wasm") ? "application/wasm" : path.endsWith(".js") ? "text/javascript" : "application/octet-stream");
        response.end(await readFile(resolve("apps/web/public" + path)));
        return;
      }
      if (path === "/portrait.jpg") {
        response.setHeader("Content-Type", "image/jpeg");
        response.end(await readFile("apps/web/src/call-states/camera-fixtures/portrait.jpg"));
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end('<html><body style="background:#141518;color:white;font:16px sans-serif"><h1>Camera background SFU proof</h1></body></html>');
    } catch {
      response.statusCode = 404;
      response.end();
    }
  });
  server.listen(config.ports.web, "127.0.0.1");
  await once(server, "listening");
  report.stage = "join sender and receiver";
  console.log(report.stage);
  for (let index = 0; index < 2; index++) {
    const admission = await chalk.participants.admit(space.id, episode.id, { name: index ? "Receiver" : "Sender", role: "owner" });
    let grant = admission.access,
      first = true,
      accessQueue = Promise.resolve();
    const browser = await chromium.launch({ headless: false, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
    browsers.push(browser);
    const context = await browser.newContext({ permissions: ["camera"], viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => console.error("Browser error:", error.message));
    await page.exposeFunction("proofAccess", () => {
      const next = accessQueue.then(async () => {
        if (first) {
          first = false;
          return grant;
        }
        grant = await chalk.participants.issueAccess(space.id, episode.id, admission.participant.id, getAccessRefreshState(grant));
        return grant;
      });
      accessQueue = next.catch(() => undefined);
      return next;
    });
    await page.goto(config.urls.web);
    await page.addScriptTag({ content: browserBundle.outputFiles[0].text });
    await page.evaluate(({ slug, api, sync, name, camera }) => window.joinProof(slug, api, sync, name, camera), { slug: space.slug, api: config.urls.api, sync: `ws://127.0.0.1:${config.ports.sync}/v1/sync`, name: index ? "Receiver" : "Sender", camera: index === 0 });
  }
  const [sender, receiver] = pages;
  report.stage = "receive camera through SFU";
  console.log(report.stage);
  await sender.waitForFunction(() => client.getSnapshot().connection.status === "live" && client.getSnapshot().media.local.camera.state === "enabled", undefined, { timeout: 60000 });
  await receiver.waitForFunction(() => client.getSnapshot().media.remote.some((item) => item.source === "camera" && item.track.readyState === "live"), undefined, { timeout: 60000 });
  for (const [index, page] of pages.entries())
    await page.evaluate(async (index) => {
      const media = index ? client.getSnapshot().media.remote.find((item) => item.source === "camera") : client.getSnapshot().media.local.camera;
      window.originalTrack = media.track;
      window.originalPublication = media.publicationId;
      const title = document.createElement("h2");
      title.textContent = index ? "Remote" : "Local";
      document.body.appendChild(title);
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([media.track]);
      video.style.cssText = "width:960px;max-width:100%";
      document.body.appendChild(video);
      window.proofVideo = video;
      await video.play();
    }, index);
  const pixels = () =>
    receiver.evaluate(async () => {
      const video = window.proofVideo;
      const target = video.getVideoPlaybackQuality().totalVideoFrames + 12;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error("No remote frames")), 15000);
        const frame = () => {
          if (video.getVideoPlaybackQuality().totalVideoFrames >= target) {
            clearTimeout(timeout);
            resolve();
          } else video.requestVideoFrameCallback(frame);
        };
        video.requestVideoFrameCallback(frame);
      });
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 36;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, 64, 36);
      return Array.from(ctx.getImageData(0, 0, 12, 36).data);
    });
  const original = await pixels();
  report.effects = [];
  for (const background of ["blur", "modern-acoustic-office", "none"]) {
    report.stage = `switch ${background}`;
    console.log(report.stage);
    await sender.evaluate((value) => window.changeBackground(value), background);
    const cover = await browsers[0].contexts()[0].newPage();
    // Playwright forces visibility through its original, session-scoped CDP override.
    await sender._connection.toImpl(sender).delegate._mainFrameSession._client.send("Emulation.setFocusEmulationEnabled", { enabled: false });
    await cover.bringToFront();
    await sender.waitForFunction(() => document.hidden);
    const current = await pixels();
    await cover.close();
    await sender.bringToFront();
    await sender.waitForFunction(() => !document.hidden);
    let diff = 0;
    for (let i = 0; i < current.length; i++) diff += Math.abs(current[i] - original[i]);
    diff /= current.length;
    if (background !== "none") assert.ok(diff > 12, `remote ${background} pixels must change: ${diff}`);
    assert.equal(await sender.evaluate(() => client.getSnapshot().media.local.camera.track === window.originalTrack && originalTrack.readyState === "live"), true);
    assert.equal(
      await receiver.evaluate(() => {
        const item = client.getSnapshot().media.remote.find((item) => item.source === "camera");
        return item.publicationId === window.originalPublication && item.track === window.originalTrack && item.track.readyState === "live";
      }),
      true,
    );
    report.effects.push({ background, remotePixelDifference: diff, samePublication: true, sameSenderTrack: true, sameReceiverTrack: true, senderHidden: true });
    if (background !== "none") for (const [index, page] of pages.entries()) await page.screenshot({ path: `${output}/${background}-${index ? "remote" : "local"}.png` });
  }
  report.assertions.push("remote SFU receives blur and image pixels", "switching retains publication and both tracks", "None restores live camera");
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.error = error.message;
  throw error;
} finally {
  for (const page of pages)
    await page
      .evaluate(async () => {
        await window.client?.leave();
        window.client?.dispose();
        window.synthetic?.stop();
      })
      .catch(() => undefined);
  for (const browser of browsers) await browser.close();
  if (episode && chalk) await chalk.episodes.end(space.id, episode.id).catch(() => undefined);
  if (server) await new Promise((resolve) => server.close(resolve));
  await runtime.stop();
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
