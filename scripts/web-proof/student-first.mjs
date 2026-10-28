import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChalkAPIError, createChalkServerClient } from "../../sdks/typescript/client/dist/server/index.js";
import { sourceAliases } from "../../apps/web/vite.aliases.ts";

const root = fileURLToPath(new URL("../..", import.meta.url));
const { chromium } = createRequire(new URL("../../sdks/typescript/client/package.json", import.meta.url))("playwright");
const { build } = createRequire(new URL("../../tools/sdk-web-consumer-e2e/package.json", import.meta.url))("esbuild");
const localURL = (value) => {
  const url = new URL(value);
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "This proof only accepts local services");
  return url.origin;
};
const api = localURL(process.env.CHALK_PROOF_API_URL ?? "http://127.0.0.1:8080");
const web = localURL(process.env.CHALK_PROOF_WEB_URL ?? "http://127.0.0.1:3070");
const sync = new URL(process.env.CHALK_PROOF_SYNC_URL ?? "ws://127.0.0.1:4100/v1/sync");
localURL(sync.href);
const directory = resolve(process.env.CHALK_STUDENT_FIRST_DIRECTORY ?? ".private/web-proof/student-first");
const chalk = createChalkServerClient({
  apiBaseURL: api,
  apiKey: process.env.CHALK_PROOF_API_KEY,
  tenantId: process.env.CHALK_PROOF_TENANT_ID,
  fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) }),
});
const evidence = { result: "failed", stages: [], pageErrors: [], cleanupErrors: [] };
const contexts = [];
let space;
let episode;
let browser;
let server;
await mkdir(directory, { recursive: true });
try {
  space = await chalk.spaces.create(
    {
      name: "Student first proof",
      slug: `student-first-${crypto.randomUUID()}`,
      mediaPlane: "cf_sfu",
      defaultEpisodeDurationSeconds: 3600,
      maximumEpisodeDurationSeconds: 3600,
      lingerWindowSeconds: 120,
      recordingPolicy: "disabled",
      transcriptionPolicy: "disabled",
    },
    { idempotencyKey: crypto.randomUUID() },
  );
  const startedAt = new Date().toISOString();
  const idempotency = { idempotencyKey: crypto.randomUUID() };
  episode = await chalk.episodes.create(space.id, { startedAt }, idempotency);
  await assert.rejects(
    () => chalk.episodes.create(space.id, { startedAt: new Date(Date.parse(startedAt) + 1000).toISOString() }, idempotency),
    (error) => error instanceof ChalkAPIError && error.status === 409 && error.code === "request.idempotency_conflict",
  );
  const replay = await chalk.episodes.create(space.id, { startedAt }, idempotency);
  assert.equal(replay.id, episode.id);
  evidence.stages.push({ phase: "episode-idempotency", changedTimestamp: "request.idempotency_conflict", exactReplay: "same Episode" });

  const studentSeat = await chalk.participants.admit(space.id, episode.id, { name: "Student", role: "collaborator" }, { idempotencyKey: crypto.randomUUID() });
  assert.ok(studentSeat.access);
  const seats = new Map([["Student", studentSeat]]);
  const bundle = await build({
    stdin: {
      contents: `import React from "react";
        import { createRoot } from "react-dom/client";
        import { Chalk } from "@q9labsai/chalk-react";
        import { createSpaceClientForPlatform } from "@q9labsai/chalk-client/effect";
        const name = new URL(location.href).searchParams.get("name");
        const client = createSpaceClientForPlatform({ space: ${JSON.stringify(space.slug)}, baseUrl: location.origin,
          getAccess: async () => { const response = await fetch("/access?name=" + name); if (!response.ok) throw new Error("Proof access failed"); return response.json(); }
        }, { syncUrl: ${JSON.stringify(sync.href)} });
        window.client = client;
        createRoot(document.getElementById("root")).render(React.createElement(Chalk, { client, displayName: name, spaceName: "Student first proof", defaults: { camera: true, microphone: true }, features: { recording: false, sounds: false } }));`,
      resolveDir: resolve(root, "apps/web"),
      loader: "jsx",
    },
    plugins: [
      {
        name: "web-source-aliases",
        setup(builder) {
          for (const alias of sourceAliases) {
            builder.onResolve({ filter: typeof alias.find === "string" ? new RegExp(`^${alias.find}$`) : alias.find }, () => ({ path: alias.replacement }));
          }
        },
      },
    ],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff2": "dataurl", ".woff": "dataurl", ".ttf": "dataurl", ".css": "empty" },
  });
  const html = `<!doctype html><title>Student first proof</title><script type="module">import "${web}/src/styles.css";</script><style>html,body,#root{margin:0;width:100%;height:100%}</style><div id="root"></div><script type="module" src="/client.js"></script>`;
  server = createServer((request, response) => {
    serve(request, response).catch((error) => {
      evidence.pageErrors.push(error.message);
      response.writeHead(500).end("Proof request failed");
    });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const student = await participant("Student");
  await student.waitForFunction(() => window.client.getSnapshot().connection.status === "live");
  assert.deepEqual(await student.evaluate(() => window.client.getSnapshot().participants.roster.map((entry) => entry.role)), ["collaborator"]);
  await student.waitForFunction(() => [...document.querySelectorAll("video")].some((video) => video.readyState >= 2));
  await student.screenshot({ path: `${directory}/student-first.png` });
  evidence.stages.push({ phase: "student-first", connection: "live", roles: ["collaborator"] });
  const teacher = await participant("Teacher");
  await teacher.waitForFunction(() => window.client.getSnapshot().connection.status === "live");
  await student.getByLabel("Video tile for Teacher", { exact: true }).waitFor();
  await student.waitForFunction(() => [...document.querySelectorAll("video")].filter((video) => video.readyState >= 2 && video.currentTime > 0).length >= 2, null, { timeout: 60_000 });
  assert.equal(await student.evaluate(() => window.client.getSnapshot().connection.status), "live");
  assert.equal(await student.evaluate(() => window.client.getSnapshot().participants.roster.length), 2);
  await student.screenshot({ path: `${directory}/teacher-joined.png` });
  evidence.stages.push({ phase: "teacher-joined", connection: "live", participants: 2, playingVideos: 2, studentClicks: 0 });
  assert.deepEqual(evidence.pageErrors, []);
  evidence.result = "passed";

  async function participant(name) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, permissions: ["camera", "microphone"] });
    contexts.push(context);
    const page = await context.newPage();
    page.on("pageerror", (error) => evidence.pageErrors.push(error.message));
    await page.goto(`${origin}/?name=${name}`);
    return page;
  }

  async function serve(request, response) {
    if (request.url.startsWith("/access?")) return serveAccess(request, response);
    if (request.url.startsWith("/v1/")) return proxyMediaRequest(request, response);
    const asset = request.url === "/client.js" ? { type: "text/javascript", body: bundle.outputFiles[0].text } : { type: "text/html", body: html };
    response.setHeader("content-type", asset.type);
    response.end(asset.body);
  }

  async function serveAccess(request, response) {
    const name = new URL(request.url, origin).searchParams.get("name");
    assert.ok(name === "Student" || name === "Teacher");
    let seat = seats.get(name);
    if (!seat) {
      seat = await chalk.participants.admit(space.id, episode.id, { name, role: "owner" }, { idempotencyKey: crypto.randomUUID() });
      seats.set(name, seat);
    }
    assert.ok(seat.access);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(seat.access));
  }

  async function proxyMediaRequest(request, response) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const headers = { ...request.headers };
    delete headers.host;
    const body = Buffer.concat(chunks);
    const upstream = await fetch(api + request.url, { method: request.method, headers, body: body.length ? body : undefined, signal: AbortSignal.timeout(15_000) });
    response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
    response.end(Buffer.from(await upstream.arrayBuffer()));
  }
} finally {
  for (const cleanup of [
    ...contexts.map((context) => () => context.close()),
    () => browser?.close(),
    () => server && new Promise((done) => server.close(done)),
    () => episode && chalk.episodes.end(space.id, episode.id, { idempotencyKey: crypto.randomUUID() }),
    () => space && chalk.spaces.archive(space.id),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      evidence.cleanupErrors.push(error.message);
    }
  }
  if (evidence.cleanupErrors.length) evidence.result = "failed";
  await writeFile(`${directory}/result.json`, JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence));
  assert.deepEqual(evidence.cleanupErrors, []);
}
