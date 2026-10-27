// Real Chromium + Sync wire fixture. No production requests or credentials.
// Run: node scripts/web-proof/connection-lost.mjs [output-dir]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "tsup";
import { chromium } from "playwright";

const output = resolve(process.argv[2] ?? ".private/connection-lost-proof");
await mkdir(output, { recursive: true });
const baseline = execFileSync("git", ["merge-base", "HEAD", "origin/master"], { encoding: "utf8" }).trim();
const changed = ["sdks/typescript/client/src/connection/lifecycle.ts", "sdks/typescript/client/src/space-client/failure-detail.ts", "sdks/typescript/react/src/components/chalk/StatusSurface.tsx"];
const entry = resolve(output, "page.tsx");
await writeFile(
  entry,
  `
import React from "react";
import { createRoot } from "react-dom/client";
import { createSpaceClientForPlatform } from "${resolve("sdks/typescript/client/src/space-client/space-client.ts")}";
import { computeV1StateDigest } from "${resolve("sdks/typescript/client/src/sync/v1-reducer.ts")}";
import { Chalk } from "${resolve("sdks/typescript/react/src/components/chalk/Chalk.tsx")}";
const participant = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const recovery = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c23";
const deadline = Date.now() + 300000;
const digest = await computeV1StateDigest({ revision: 1, stateSchemaVersion: 1, stateDigest: "0".repeat(64), status: "active", admissionPolicy: "open", deadlineAtMs: deadline, deadlineGeneration: 1, roleCapabilities: { owner: [] }, recording: null, participants: [{ participantId: participant, displayName: "You", handRaised: false, admissionRevision: 1, role: "owner", eligibleRoles: [], capabilities: [] }, { participantId: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22", displayName: "Remote participant", handRaised: false, admissionRevision: 1, role: "member", eligibleRoles: [], capabilities: [] }], admissionRequests: [] });
const head = { revision: 1, state_schema_version: 1, state_digest: digest };
await fetch("/frames", { method: "POST", body: JSON.stringify([
  { type: "welcome", protocol: 1, participant_id: participant, participant_generation: 1, recovery_id: recovery, head, mode: "snapshot", entry_confirmation: true, entry_generation: 1, snapshot: { control_revision: 1, state_schema_version: 1, state_digest: digest, status: "active", admission_policy: "open", deadline_at_ms: deadline, deadline_generation: 1, role_capabilities: { owner: [] }, recording: null, participants: [{ participant_id: participant, display_name: "You", hand_raised: false, admission_revision: 1, role: "owner", capabilities: [] }, { participant_id: "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22", display_name: "Remote participant", hand_raised: false, admission_revision: 1, role: "member", capabilities: [] }], admission_requests: [] } },
  ...["media", "presence"].map(stream => ({ type: "projection_snapshot", stream, projection_id: recovery, sequence: 0, items: [] })),
  { type: "recovery_complete", recovery_id: recovery, head }
]) });
const token = audience => btoa('{"alg":"EdDSA"}') + "." + btoa(JSON.stringify({ aud: audience })) + ".fixture";
const expires = new Date(deadline).toISOString();
const diagnostics = [];
let dialCount = 0;
globalThis.WebSocket = new Proxy(globalThis.WebSocket, {
  construct(target, args) { dialCount += 1; return Reflect.construct(target, args); }
});
const client = createSpaceClientForPlatform({ space: "fixture", baseUrl: location.origin, getAccess: async () => ({ subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: participant, participant_generation: 1 }, sync: { token: token("chalk-sync"), expires_at: expires }, media: { token: token("chalk-media"), expires_at: expires, provider: "cloudflare_sfu", client_payload: { connectionId: "connection-1", stunServer: "stun:127.0.0.1:9" } } }) }, { apiBaseUrl: location.origin, syncUrl: location.origin.replace("http", "ws") + "/v1/sync", whiteboardUrl: null, onConnectionDiagnostic: event => diagnostics.push(event) });
const root = createRoot(document.getElementById("root"));
root.render(<Chalk client={client} spaceName="Fixture call" defaults={{ microphone: false, camera: false }} features={{ sounds: false, whiteboard: false }} />);
window.proof = { client, diagnostics, snapshot: () => ({ connection: client.getSnapshot().connection, roster: client.getSnapshot().participants.roster.map(p => p.displayName), remoteTracks: client.getSnapshot().media.remote.length }) };
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
const aliases = {
  "@q9labsai/chalk-client": "sdks/typescript/client/src/index.ts",
  "@q9labsai/chalk-ui/reactions": "packages/ui/src/reactions.ts",
  "@q9labsai/chalk-ui/assets": "packages/ui/src/assets.ts",
  "@q9labsai/chalk-ui/button": "packages/ui/src/button.tsx",
  "@q9labsai/chalk-ui": "packages/ui/src/index.ts",
  "@q9labsai/chalk-assets": "packages/assets/src/index.ts",
  "@q9labsai/chalk-whiteboard/react": "packages/whiteboard/src/react/index.ts",
  "@q9labsai/chalk-whiteboard": "packages/whiteboard/src/index.ts",
  "@q9labsai/facehash/react": "packages/facehash/src/react.ts",
  "@q9labsai/facehash": "packages/facehash/src/index.ts",
};
const browser = await chromium.launch({ headless: true });
const lifetime = setTimeout(() => {
  process.exitCode = 1;
  void browser.close();
}, 600000);
const results = [];
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
        options.alias = Object.fromEntries(Object.entries(aliases).map(([name, path]) => [name, resolve(path)]));
        options.nodePaths = [resolve("apps/web/node_modules"), resolve("sdks/typescript/react/node_modules")];
        options.jsx = "automatic";
        options.loader = { ...options.loader, ".woff2": "dataurl", ".svg": "dataurl", ".png": "dataurl", ".wasm": "file" };
      },
      esbuildPlugins:
        revision === "before"
          ? [
              {
                name: "baseline",
                setup(builder) {
                  builder.onLoad({ filter: /(?:connection\/lifecycle\.ts|space-client\/failure-detail\.ts|chalk\/StatusSurface\.tsx)$/ }, ({ path }) => {
                    const relative = changed.find((file) => path === resolve(file));
                    return relative ? { contents: execFileSync("git", ["show", `${baseline}:${relative}`], { encoding: "utf8" }), loader: path.endsWith("tsx") ? "tsx" : "ts" } : undefined;
                  });
                },
              },
            ]
          : [],
    });
    for (const [device, width, height] of [
      ["laptop", 1440, 900],
      ["phone", 390, 844],
    ]) {
      let frames = [];
      const sockets = new Set();
      const server = createServer(async (request, response) => {
        if (request.url === "/frames") {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          frames = JSON.parse(Buffer.concat(chunks).toString());
          response.writeHead(204).end();
        } else if (request.url === "/page.js") {
          response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(resolve(directory, "page.js")));
        } else {
          response.writeHead(200, { "content-type": "text/html" }).end('<html><head><style>html,body,#root{height:100%;margin:0;background:#000;color:#eee;font:14px Arial}button{cursor:pointer}</style></head><body><div id="root"></div><script type="module" src="/page.js"></script></body></html>');
        }
      });
      server.on("connection", (socket) => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
      });
      server.on("upgrade", (request, socket) => {
        const accept = createHash("sha1")
          .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        let buffered = Buffer.alloc(0);
        // Minimal RFC6455 fixture accepts partial/coalesced masked browser frames.
        // Kept here with the socket owner; no production parser is changed.
        // fallow-ignore-next-line complexity
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
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const context = await browser.newContext({ viewport: { width, height }, recordVideo: { dir: resolve(output, "video"), size: { width, height } } });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => console.error("pageerror", error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}`);
        await page.waitForFunction(() => window.proof?.client.getSnapshot().connection.status === "live");
        assert.equal(await page.getByText("Remote participant", { exact: true }).count(), 1);
        const live = await page.evaluate(() => window.proof.snapshot());
        await context.setOffline(true);
        await page.waitForFunction(() => window.proof.client.getSnapshot().connection.lastError?.code === "connection.sync_recovery_exhausted", null, { timeout: 45000 });
        const exhausted = await page.evaluate(() => ({ ...window.proof.snapshot(), diagnostics: window.proof.diagnostics }));
        if (revision === "before") {
          assert.equal(exhausted.connection.status, "reconnecting");
          assert.ok(exhausted.roster.includes("Remote participant"));
        } else {
          await page.getByRole("heading", { name: "Connection lost", exact: true }).waitFor();
          await page.getByRole("button", { name: "Rejoin", exact: true }).waitFor();
          assert.equal(exhausted.connection.status, "failed");
          assert.deepEqual(exhausted.roster, []);
          assert.equal(exhausted.remoteTracks, 0);
          assert.equal(await page.getByText("Remote participant", { exact: true }).count(), 0);
        }
        await page.evaluate(
          (label) => {
            const tag = document.createElement("div");
            tag.textContent = label;
            tag.style.cssText = "position:fixed;bottom:0;left:0;z-index:1000;padding:8px 16px;background:#fff;color:#000;font:14px Arial";
            document.body.append(tag);
          },
          `${revision === "before" ? "Before" : "After"}: ${width}px, dark, recovery exhausted`,
        );
        await page.screenshot({ path: resolve(output, `${revision}-${device}.png`) });
        if (revision === "after") {
          await context.setOffline(false);
          await page.getByRole("button", { name: "Rejoin", exact: true }).click();
          await page.waitForFunction(() => window.proof.client.getSnapshot().connection.status === "live");
          assert.equal(await page.getByText("Remote participant", { exact: true }).count(), 1);
          assert.equal(await page.evaluate(() => window.proof.client.getSnapshot().connection.lastError), null);
        }
        results.push({ revision, device, live, exhausted, rejoinVerified: revision === "after" });
        await page.evaluate(() => window.proof.client.dispose());
      } finally {
        await context.close();
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  }
  await writeFile(resolve(output, "results.json"), JSON.stringify({ baseline, head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), results }, null, 2));
  console.log(JSON.stringify(results.map(({ revision, device, exhausted, rejoinVerified }) => ({ revision, device, status: exhausted.connection.status, code: exhausted.connection.lastError?.code, roster: exhausted.roster, rejoinVerified }))));
} finally {
  clearTimeout(lifetime);
  await browser.close();
}
