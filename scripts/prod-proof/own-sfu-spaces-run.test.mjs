import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { runLabel } from "./cleanup.mjs";

const execute = promisify(execFile);
const workflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/real-call-proof.yml"), "utf8");
const indexPath = resolve(import.meta.dirname, "index.mjs");

// The real-call-proof workflow names each invocation <32-character suffix>-<proof>.
// Run its own shell line for every proof it accepts, then the same validation the script runs first.
test("the run ID the workflow builds is valid for every proof it accepts", async () => {
  const names = /^\s*(all\|[a-z|-]+)\) ;;$/m.exec(workflow)?.[1].split("|");
  assert.ok(names?.includes("own-sfu-spaces") && names.includes("leave-own-sfu"));
  const line = /^\s*(run_id="\$\{RUN_PREFIX\}-\$\{proof\}")$/m.exec(workflow)?.[1];
  assert.ok(line, "the workflow no longer builds run_id from RUN_PREFIX and proof");
  const suffix = "0123456789abcdef0123456789abcdef";
  for (const proof of names) {
    const { stdout } = await execute("bash", ["-c", `${line}; printf %s "$run_id"`], { env: { RUN_PREFIX: suffix, proof } });
    assert.ok(stdout.length <= 51, `${stdout} has ${stdout.length} characters`);
    assert.equal(runLabel(stdout), `chalk-proof:${stdout}`);
  }
});

// A tenant API that behaves as the release in production does ("old": it lets the public API move a Space on the
// allowlist) or as the release Promote deploys ("new": it refuses chalk_sfu).
function fakeApi({ release, allowed = true, preexisting = [] }) {
  const spaces = new Map(preexisting.map((space) => [space.id, space]));
  const log = [];
  let revoked = false;
  const send = (response, status, body) => {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
  };
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      const body = text ? JSON.parse(text) : undefined;
      const url = new URL(request.url, "http://x");
      log.push(`${request.method} ${url.pathname}`);
      const spaceId = /\/spaces\/([^/]+)$/.exec(url.pathname)?.[1];
      if (revoked && request.headers.authorization === "Bearer chalk_sk_proof") return send(response, 401, { error: { code: "auth.invalid_api_key", message: "revoked" } });
      if (url.pathname === "/readyz") return send(response, 200, { capabilities: { recording: "enabled", transcription: "enabled" } });
      if (request.method === "POST" && url.pathname.endsWith("/api-keys")) return send(response, 201, { api_key: { id: "key" }, secret: "chalk_sk_proof" });
      if (request.method === "DELETE" && url.pathname.includes("/api-keys/")) {
        revoked = true;
        return send(response, 200, {});
      }
      if (request.method === "GET" && url.pathname.endsWith("/spaces")) return send(response, 200, { spaces: [...spaces.values()], pagination: { next_cursor: "" } });
      if (request.method === "POST" && url.pathname.endsWith("/spaces")) {
        const space = { id: `space-${spaces.size}`, archived: false, media_plane: "cf_sfu", ...body };
        spaces.set(space.id, space);
        return send(response, 201, space);
      }
      if (request.method === "GET" && spaceId) return spaces.has(spaceId) ? send(response, 200, spaces.get(spaceId)) : send(response, 404, { error: { code: "resource.not_found", message: "absent" } });
      if (request.method === "PATCH" && spaceId) {
        if (release === "new" || !allowed) return send(response, 403, { error: { code: "space.media_plane_not_permitted", message: "refused" } });
        const space = { ...spaces.get(spaceId), media_plane: body.media_plane };
        spaces.set(spaceId, space);
        return send(response, 200, space);
      }
      send(response, 500, { error: { code: "unexpected", message: `${request.method} ${url.pathname}` } });
    });
  });
  return { server, spaces, log };
}

async function runStep(api, env = {}) {
  await new Promise((done) => api.server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${api.server.address().port}`;
  const directory = await mkdtemp(`${tmpdir()}/own-sfu-spaces-`);
  const runId = "0123456789abcdef0123456789abcdef-own-sfu-spaces";
  let result;
  try {
    result = await execute("node", [indexPath, "own-sfu-spaces"], {
      cwd: directory,
      env: {
        PATH: process.env.PATH,
        CHALK_PROOF_CONFIG_SOURCE: "env",
        CHALK_PROOF_PROOF_ORIGIN: url,
        CHALK_PROOF_API_KEY: "chalk_sk_bootstrap",
        CHALK_PROOF_TENANT_ID: "tenant",
        CHALK_PROOF_API_URL: url,
        CHALK_PROOF_WEB_URL: url,
        CHALK_PROOF_WEBHOOK_SERVICE_URL: url,
        CHALK_PROOF_WEBHOOK_ENDPOINT_ID: "endpoint",
        CHALK_PROOF_RUN_ID: runId,
        CHALK_PROOF_MEDIA_PLANE: "chalk_sfu",
        ...env,
      },
    });
  } catch (error) {
    result = { ...error, failed: true };
  } finally {
    api.server.close();
  }
  const report = JSON.parse(await readFile(`${directory}/.private/prod-proof/${runId}/report.json`, "utf8"));
  return { result, report };
}

test("the step run by Promote creates both proof Spaces and moves them to chalk_sfu on the release in production", async () => {
  const api = fakeApi({ release: "old" });
  const { result, report } = await runStep(api);
  assert.equal(result.failed, undefined, result.stderr);
  assert.equal(report.result, "passed");
  assert.equal(report.cleanup, "passed");
  assert.deepEqual(
    [...api.spaces.values()].map((space) => [space.slug, space.media_plane, space.recording_policy, space.transcription_policy]),
    [
      ["promote-proof-chalk-sfu", "chalk_sfu", "manual", "on_demand"],
      ["promote-proof-chalk-sfu-automatic", "chalk_sfu", "automatic", "automatic"],
    ],
  );
  assert.ok(
    api.log.every((entry) => !entry.startsWith("DELETE") || entry.includes("/api-keys/")),
    "only the proof key is deleted",
  );
});

test("a second run finds the Spaces and changes nothing", async () => {
  const done = (slug, policy) => ({ id: slug, slug, archived: false, effective_media_plane: "chalk_sfu", media_plane: "chalk_sfu", ...policy });
  const api = fakeApi({
    release: "new",
    preexisting: [done("promote-proof-chalk-sfu", { recording_policy: "manual", transcription_policy: "on_demand" }), done("promote-proof-chalk-sfu-automatic", { recording_policy: "automatic", transcription_policy: "automatic" })],
  });
  const { result, report } = await runStep(api);
  assert.equal(result.failed, undefined, result.stderr);
  assert.equal(report.result, "passed");
  assert.ok(!api.log.some((entry) => entry.startsWith("PATCH") || (entry.startsWith("POST") && entry.endsWith("/spaces"))));
});

test("an API that refuses the plane stops the step, naming the Space and the operator step", async () => {
  const api = fakeApi({ release: "old", allowed: false });
  const { result, report } = await runStep(api);
  assert.equal(result.failed, true);
  assert.equal(report.result, "failed");
  assert.match(result.stderr, /proof Space promote-proof-chalk-sfu /);
  assert.match(result.stderr, /CHALK_SFU_ALLOWED_SPACES/);
});

test("a Space an operator pinned is the one checked and moved, and a missing one stops the step", async () => {
  const operator = { id: "operator", slug: "operator-space", archived: false, media_plane: "cf_sfu", recording_policy: "manual", transcription_policy: "on_demand" };
  const api = fakeApi({ release: "old", preexisting: [operator] });
  const { result, report } = await runStep(api, { CHALK_PROOF_SPACE_ID_CHALK_SFU: "operator" });
  assert.equal(result.failed, undefined, result.stderr);
  assert.equal(report.result, "passed");
  assert.equal(api.spaces.get("operator").media_plane, "chalk_sfu");
  assert.deepEqual(
    [...api.spaces.values()].filter((space) => space.slug !== "operator-space").map((space) => space.slug),
    ["promote-proof-chalk-sfu-automatic"],
  );
  const missing = await runStep(fakeApi({ release: "old" }), { CHALK_PROOF_SPACE_ID_CHALK_SFU: "gone" });
  assert.equal(missing.result.failed, true);
  assert.match(missing.result.stderr, /CHALK_PROOF_SPACE_ID_CHALK_SFU names a Space that does not exist/);
});
