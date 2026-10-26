// Local protocol fixture: real Chromium, WebSocket, SDK and failed-call screen.
// No production requests. Run: node scripts/web-proof/join-startup.mjs [output-dir]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "tsup";
import { chromium, devices } from "playwright";

const output = resolve(process.argv[2] ?? ".private/join-startup-proof");
await mkdir(output, { recursive: true });
const lifecycle = "sdks/typescript/client/src/connection/lifecycle.ts";
const surface = "sdks/typescript/react/src/components/chalk/StatusSurface.tsx";
const diagnostics = "sdks/typescript/client/src/sync/connect-diagnostics.ts";
const transport = "sdks/typescript/client/src/sync/v1-client.ts";
const baseline = execFileSync("git", ["merge-base", "HEAD", "origin/master"], { encoding: "utf8" }).trim();
const entry = resolve(output, "page.tsx");
await writeFile(
  entry,
  `
import React from "react";
import { createRoot } from "react-dom/client";
import { createSpaceClientForPlatform } from "${resolve("sdks/typescript/client/src/space-client/space-client.ts")}";
import { computeV1StateDigest } from "${resolve("sdks/typescript/client/src/sync/v1-reducer.ts")}";
import { StatusSurface } from "${resolve(surface)}";
const participant = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const recovery = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const deadline = Date.now() + 300000;
const digest = await computeV1StateDigest({ revision: 1, stateSchemaVersion: 1, stateDigest: "0".repeat(64), status: "active", admissionPolicy: "open", deadlineAtMs: deadline, deadlineGeneration: 1, roleCapabilities: { owner: [] }, recording: null, participants: [{ participantId: participant, displayName: "Fixture", handRaised: false, admissionRevision: 1, role: "owner", eligibleRoles: [], capabilities: [] }], admissionRequests: [] });
const head = { revision: 1, state_schema_version: 1, state_digest: digest };
await fetch("/frames", { method: "POST", body: JSON.stringify([
  { type: "welcome", protocol: 1, participant_id: participant, participant_generation: 1, recovery_id: recovery, head, mode: "snapshot", entry_confirmation: true, entry_generation: 1, snapshot: { control_revision: 1, state_schema_version: 1, state_digest: digest, status: "active", admission_policy: "open", deadline_at_ms: deadline, deadline_generation: 1, role_capabilities: { owner: [] }, recording: null, participants: [{ participant_id: participant, display_name: "Fixture", hand_raised: false, admission_revision: 1, role: "owner", capabilities: [] }], admission_requests: [] } },
  ...["media", "presence"].map(stream => ({ type: "projection_snapshot", stream, projection_id: recovery, sequence: 0, items: [] })),
  { type: "recovery_complete", recovery_id: recovery, head }
]) });
const token = audience => btoa('{"alg":"EdDSA"}') + "." + btoa(JSON.stringify({ aud: audience })) + ".fixture";
const expires = new Date(deadline).toISOString();
const diagnostics = [];
const client = createSpaceClientForPlatform({ space: "fixture", baseUrl: location.origin, getAccess: async () => ({ subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: participant, participant_generation: 1 }, sync: { token: token("chalk-sync"), expires_at: expires }, media: { token: token("chalk-media"), expires_at: expires, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:127.0.0.1:9" } } }) }, { apiBaseUrl: location.origin, syncUrl: location.origin.replace("http", "ws") + "/v1/sync", whiteboardUrl: null, onConnectionDiagnostic: event => diagnostics.push(event) });
const root = createRoot(document.getElementById("root"));
const started = performance.now();
root.render(<StatusSurface phase="entering" callName="Fixture call" />);
try {
  await client.join({ microphone: false, camera: false });
  root.render(<h1>Joined Fixture call</h1>);
} catch {
  const error = client.getSnapshot().connection.lastError;
  root.render(<StatusSurface phase="failed" callName="Fixture call" errorCode={error?.code} sync={error?.sync} onRetry={() => {}} onHome={() => {}} />);
}
window.proof = { connection: client.getSnapshot().connection, diagnostics, elapsedMs: Math.round(performance.now() - started) };
window.disposeProof = () => client.dispose();
`,
);

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = payload.length < 126 ? payload.length : 126;
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

const browser = await chromium.launch({ headless: true });
const results = [];
const lifetime = setTimeout(() => {
  process.exitCode = 1;
  void browser.close();
}, 600000);
try {
  for (const revision of ["before", "after"]) {
    const directory = resolve(output, revision);
    await build({
      entry: { page: entry },
      outDir: directory,
      format: ["esm"],
      platform: "browser",
      target: "es2022",
      splitting: false,
      silent: true,
      noExternal: [/.*/],
      esbuildOptions(options) {
        options.alias = { "@q9labsai/chalk-client": resolve("sdks/typescript/client/src/index.ts") };
        options.nodePaths = [resolve("apps/web/node_modules")];
        options.jsx = "automatic";
      },
      esbuildPlugins:
        revision === "before"
          ? [
              {
                name: "baseline",
                setup(builder) {
                  builder.onLoad({ filter: /(?:connection\/lifecycle\.ts|chalk\/StatusSurface\.tsx|sync\/(?:connect-diagnostics|v1-client)\.ts)$/ }, ({ path }) => ({
                    contents: execFileSync("git", ["show", `${baseline}:${path.endsWith("lifecycle.ts") ? lifecycle : path.endsWith("StatusSurface.tsx") ? surface : path.endsWith("v1-client.ts") ? transport : diagnostics}`], { encoding: "utf8" }),
                    loader: path.endsWith("tsx") ? "tsx" : "ts",
                  }));
                },
              },
            ]
          : [],
    });
    const bundle = await readFile(resolve(directory, "page.js"));
    async function runCase(scenario, device, trial = 0) {
      let attempts = 0;
      const lossPattern = trial % 2 === 0 ? ["close", "stall", "close", "open"] : ["close", "stall", "close", "stall", "close", "open"];
      let fastCloses = 0;
      let stalledDials = 0;
      let frames = [];
      const sockets = new Set();
      const timers = new Set();
      const server = createServer(async (request, response) => {
        if (request.url === "/page.js") {
          response.setHeader("Content-Type", "text/javascript");
          response.end(bundle);
        } else if (request.url === "/frames") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          frames = JSON.parse(Buffer.concat(chunks).toString());
          response.end("ok");
        } else if (request.url.includes("/publications")) {
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ incarnation: 1, sequence: 0, publications: [] }));
        } else {
          response.setHeader("Content-Type", "text/html");
          response.end(
            '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;font:14px/1.4 Arial;background:#0b0c0e;color:#ececee}#root{height:100dvh}.chalk-root{box-sizing:border-box;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center}h1,p{margin:0}p{color:#9a9ca3}button{background:transparent;color:inherit;border:0;display:inline-flex;align-items:center;flex-direction:column;gap:8px;font:inherit}button span{display:grid;place-items:center;width:56px;height:56px;border-radius:50%;background:#1d1f23}[data-part=status-actions]{display:flex;gap:28px;margin-top:20px}</style></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>',
          );
        }
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (request, socket) => {
        attempts += 1;
        const step = scenario === "lossy-stalled" ? lossPattern[attempts - 1] : null;
        if (scenario === "rejected" || step === "close") {
          fastCloses += 1;
          const timer = setTimeout(() => {
            timers.delete(timer);
            socket.destroy();
          }, 52);
          timers.add(timer);
          return;
        }
        if (scenario === "offline" || step === "stall" || (scenario === "retry" && attempts === 1)) {
          stalledDials += 1;
          return; // Accept TCP without sending an HTTP response.
        }
        const timer = setTimeout(
          () => {
            timers.delete(timer);
            if (socket.destroyed) return;
            const accept = createHash("sha1")
              .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
              .digest("base64");
            socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
            let buffered = Buffer.alloc(0);
            socket.on("data", (chunk) => {
              buffered = Buffer.concat([buffered, chunk]);
              while (buffered.length >= 6) {
                const opcode = buffered[0] & 15;
                let length = buffered[1] & 127;
                const offset = length === 126 ? 4 : 2;
                if (length === 127 || buffered.length < offset + 4) return;
                if (length === 126) length = buffered.readUInt16BE(2);
                if (buffered.length < offset + 4 + length) return;
                const mask = buffered.subarray(offset, offset + 4);
                const payload = buffered.subarray(offset + 4, offset + 4 + length).map((byte, index) => byte ^ mask[index % 4]);
                buffered = buffered.subarray(offset + 4 + length);
                if (opcode === 8) {
                  socket.end();
                  return;
                }
                if (opcode !== 1) continue;
                const message = JSON.parse(payload.toString());
                if (message.type === "hello") for (const item of frames) socket.write(frame(item));
                if (message.type === "entered") socket.write(frame({ type: "entered_ack" }));
              }
            });
          },
          scenario === "lossy-stalled" ? (trial % 3 === 0 ? 1600 : 600) : 8000,
        );
        timers.add(timer);
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const context = await browser.newContext(device === "phone" ? { ...devices["Pixel 7"] } : { viewport: { width: 1440, height: 900 } });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => console.error("pageerror", error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.proof, null, { timeout: 45000 });
        const result = await page.evaluate(() => window.proof);
        const expected = revision === "after" && (scenario === "retry" || scenario === "lossy-stalled") ? "live" : "failed";
        assert.ok(attempts > 0, JSON.stringify(result));
        assert.equal(result.connection.status, expected, JSON.stringify(result));
        if (expected === "live") assert.equal(attempts, scenario === "retry" ? 2 : lossPattern.length);
        if (expected === "live" && scenario === "lossy-stalled") {
          assert.equal(fastCloses / attempts, 0.5);
          assert.equal(stalledDials, trial % 2 === 0 ? 1 : 2);
        }
        if (revision === "after" && expected === "failed") assert.equal(result.connection.lastError.code, "connection.sync_start_failed");
        if (revision === "after" && scenario === "rejected") {
          assert.equal(result.connection.lastError.sync.opened, false);
          assert.equal(result.connection.lastError.sync.closeCode, 1006);
          assert.ok(result.connection.lastError.sync.durationMs < 1000);
          assert.equal(result.connection.lastError.sync.attempts, attempts);
          assert.ok(result.connection.lastError.sync.attempt <= attempts);
          await page.getByText("The connection closed before the call service could be reached. Try again.", { exact: true }).waitFor();
          await page.getByText(new RegExp(`attempts=${attempts};`)).waitFor();
        }
        if (trial < 2) await page.screenshot({ path: resolve(output, `${revision}-${scenario}-${device}-${trial}.png`) });
        await page.evaluate(() => window.disposeProof());
        results.push({ revision, scenario, device, trial, attempts, fastCloses, stalledDials, ...result });
        console.log(JSON.stringify({ revision, scenario, device, trial, attempts, fastCloses, stalledDials, status: result.connection.status, code: result.connection.lastError?.code, elapsedMs: result.elapsedMs }));
      } finally {
        await context.close();
        for (const timer of timers) clearTimeout(timer);
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }
    for (const [scenario, device] of [
      ["retry", "phone"],
      ["offline", "phone"],
      ["rejected", "phone"],
      ["rejected", "desktop"],
    ])
      await runCase(scenario, device);
    if (revision === "before") await runCase("lossy-stalled", "phone");
    else {
      for (let first = 0; first < 30; first += 4) await Promise.all(Array.from({ length: Math.min(4, 30 - first) }, (_, offset) => runCase("lossy-stalled", "phone", first + offset)));
    }
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify(results, null, 2));
} finally {
  clearTimeout(lifetime);
  await browser.close();
}
