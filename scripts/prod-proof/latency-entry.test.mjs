import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const here = import.meta.dirname;
const fakes = pathToFileURL(join(here, "latency-entry-fakes.mjs")).href;
// Only the imports that reach a browser, the API or the cloud resolve to the fakes. Everything else latency.mjs imports stays real.
const preload = `import { registerHooks } from "node:module";
const faked = new Set(["./runtime.mjs", "./cleanup.mjs", "./media.mjs", "./proofs.mjs", "./latency-probe.mjs"]);
registerHooks({ resolve: (specifier, context, next) => (context.parentURL?.endsWith("/prod-proof/latency.mjs") && faked.has(specifier) ? { url: ${JSON.stringify(fakes)}, shortCircuit: true } : next(specifier, context)) });`;

// The unit tests import single functions, so a name latency.mjs uses and no longer imports only fails when the entry point runs.
// This runs the real entry through one cycle on a fake page, fake API and fake cloud, and expects it to write the card and the sidecar.
test("the latency entry point runs a cycle and writes both the card and the diagnostics sidecar", () => {
  const directory = mkdtempSync(join(tmpdir(), "latency-entry-"));
  try {
    const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, join(here, "latency.mjs"), "--samples", "1", "--planes", "chalk_sfu", "--environment", "ci", "--tier", "manual"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, CHALK_PROOF_RUN_ID: "entry-test" },
    });
    assert.doesNotMatch(result.stderr, /Error/, result.stderr);
    const out = join(directory, ".private", "prod-proof", "entry-test");
    for (const name of ["latency.json", "scorecard-chalk_sfu.json", "latency-diagnostics-chalk_sfu.json"]) assert.equal(existsSync(join(out, name)), true, `${name} was written`);

    const card = readFileSync(join(out, "scorecard-chalk_sfu.json"), "utf8");
    const sidecar = JSON.parse(readFileSync(join(out, "latency-diagnostics-chalk_sfu.json"), "utf8"));
    assert.equal(card.includes("media."), false, "the card holds no media.* metric");
    assert.equal(card.includes("network_jitter"), false);
    // 40 ms round trip each way gives 40 ms network; 2 s of jitter buffer over 100 packets gives 20 ms.
    assert.equal(sidecar.cycles[0].audio["media.network_jitter_one_way_ms"], 60);
    assert.deepEqual(sidecar.summary.audio["media.network_jitter_one_way_ms"], { n: 1, p50: 60, p95: 60 });
    assert.match(result.stdout, /Audio delay a listener adds/);
    assert.deepEqual(sidecar.cycles[0].ice, { local_type: "host", remote_type: "srflx", requests_sent: 6, responses_received: 4, read_after_ms: 400 });
    assert.deepEqual(sidecar.summary.ice, { pairs: { "host/srflx": 1 }, unanswered_checks: { n: 1, p50: 2, p95: 2 } });
    assert.equal(card.includes("srflx"), false, "the card holds no ICE reading");
    assert.match(result.stdout, /Selected pairs: host\/srflx 1\./);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
