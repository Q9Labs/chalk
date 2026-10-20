import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { strict as assert } from "node:assert";
// A path, not new URL(): the dead-code check reads new URL() as an import that fails before a build.
const dist = resolve(import.meta.dirname, "../../dist/client");
const worker = resolve(dist, "_worker.js");
assert((await stat(worker)).isDirectory(), "Pages requires an advanced-mode _worker.js directory, not a multipart --outfile envelope");
assert((await stat(resolve(worker, "index.js"))).isFile(), "Pages worker entrypoint index.js is missing");
const sources = [];
for (const entry of await readdir(worker, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:m?js|cjs)$/.test(entry.name)) continue;
  const path = resolve(entry.parentPath, entry.name);
  const source = await readFile(path, "utf8");
  const parsed = spawnSync(process.execPath, ["--check", "--input-type=module"], { input: source, encoding: "utf8" });
  assert.equal(parsed.status, 0, `Invalid worker JavaScript in ${path}: ${parsed.stderr}`);
  sources.push(source);
}
assert(sources.length > 0, "No JavaScript worker modules were checked");
console.log(`PASS: Pages advanced-mode worker entrypoint and ${sources.length} JavaScript module(s) parse without multipart envelopes`);
const bundle = sources.join("\n");
for (const forbidden of ["fixture_ada", "fixture_malik", "/fixture/authorize", "fixture_code_rejected", "issuedSessions"]) assert(!bundle.includes(forbidden), `Production bundle contains ${forbidden}`);
console.log("PASS: production Pages bundle has no fixture identity implementation");
const routes = JSON.parse(await readFile(resolve(dist, "_routes.json"), "utf8"));
assert(routes.include.length > 0);
assert(
  routes.include.every((path) => /^\/(auth|dashboard-api)\//.test(path)),
  "Static site/docs must not invoke the dashboard worker",
);
for (const path of [
  "/auth/start",
  "/auth/callback/google",
  "/auth/callback/apple",
  "/auth/session",
  "/auth/sign-out",
  "/dashboard-api/home",
  "/dashboard-api/call",
  "/dashboard-api/call-status",
  "/dashboard-api/call-metadata",
  "/dashboard-api/home-status",
  "/dashboard-api/past-session",
  "/dashboard-api/developer",
]) {
  assert(
    routes.include.some((pattern) => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern)),
    `Missing worker route ${path}`,
  );
}
console.log("PASS: release-directory worker and generated route manifest include only auth/dashboard Functions");
