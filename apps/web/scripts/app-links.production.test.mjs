import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const webDirectory = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(new URL("../../../release/manifest.json", import.meta.url), "utf8"));
const fingerprintPattern = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

// Run after the production web build. Pages dev applies the actual _headers,
// _redirects and static-file precedence, unlike a generic static HTTP server.
test("production Pages app associations", { timeout: 180_000 }, async (t) => {
  const server = spawn("timeout", ["--kill-after=5", "150", "pnpm", "exec", "wrangler", "pages", "dev", "dist/client", "--ip", "127.0.0.1", "--port", "8794", "--inspector-port", "0"], {
    cwd: webDirectory,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(server, "exit");
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) process.kill(-server.pid, "SIGTERM");
    await exited;
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Pages startup timed out:\n${output}`)), 60_000);
    function collect(chunk) {
      output += chunk.toString();
      if (output.includes("Ready on http://127.0.0.1:8794")) {
        clearTimeout(timer);
        resolve();
      }
    }
    server.stdout.on("data", collect);
    server.stderr.on("data", collect);
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Pages exited (${code}):\n${output}`));
    });
  });

  for (const host of ["chalkmeet.com", "chalk.q9labs.ai"]) {
    for (const filename of ["apple-app-site-association", "assetlinks.json"]) {
      await t.test(`${host}/.well-known/${filename}: direct JSON response`, async () => {
        const response = await fetch(`http://127.0.0.1:8794/.well-known/${filename}`, {
          headers: { Host: host },
          redirect: "manual",
          signal: AbortSignal.timeout(10_000),
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("location"), null);
        assert.match(response.headers.get("content-type") ?? "", /^application\/json(?:;|$)/);
        const body = await response.json();
        if (filename === "apple-app-site-association") {
          assert.deepEqual(body, {
            applinks: {
              apps: [],
              details: [{ appID: `${manifest.apple.team_id}.${manifest.apple.bundle_id}`, paths: ["/space/*"] }],
            },
          });
        } else {
          assert.equal(body.length, 1);
          assert.deepEqual(body[0].relation, ["delegate_permission/common.handle_all_urls"]);
          assert.equal(body[0].target.namespace, "android_app");
          assert.equal(body[0].target.package_name, manifest.android.package_name);
          assert.ok(body[0].target.sha256_cert_fingerprints.includes(manifest.android.certificate_sha256));
          assert.ok(body[0].target.sha256_cert_fingerprints.every((value) => typeof value === "string"));
        }
      });
    }
  }

  await t.test("all Android signing fingerprints are resolved before shipping", async () => {
    const response = await fetch("http://127.0.0.1:8794/.well-known/assetlinks.json");
    const statements = await response.json();
    for (const fingerprint of statements[0].target.sha256_cert_fingerprints) {
      assert.match(fingerprint, fingerprintPattern, "Replace the Play Console app-signing certificate placeholder before deployment");
    }
  });
});
