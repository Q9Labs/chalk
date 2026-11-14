import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { ProofError, measured, publicFailure } from "./runtime.mjs";

// The public API refuses a Create Space request that names the own SFU, so a proof names no
// plane and fails at once when the Space it gets is not on the plane it asked for.
async function fakeRun(responder) {
  const requests = [];
  return {
    requests,
    directory: await mkdtemp(`${tmpdir()}/proof-space-`),
    runId: "run",
    ownership: {},
    label: "label",
    tenantPath: "/v1/tenants/t",
    apiRequest: async (method, path, body) => {
      requests.push({ method, path, body });
      return responder(method, body);
    },
  };
}

const cloudflare = "cf_sfu";
const policyApplied = { recording_policy: "manual", transcription_policy: "on_demand" };

test("a proof Space is created without naming a plane and must be on the requested one", async () => {
  const run = await fakeRun(() => ({ id: "s", effective_media_plane: "chalk_sfu", media_plane: "other", ...policyApplied }));
  const space = await createSpace(run, "chalk_sfu");
  assert.equal(space.id, "s");
  assert.equal("media_plane" in run.requests[0].body, false);
});

test("a Cloudflare proof can name its plane, so a Tenant that defaults to the own SFU still gets a Cloudflare Space", async () => {
  const plane = cloudflare;
  const run = await fakeRun((_, body) => ({ id: "s", effective_media_plane: body.media_plane ?? "other", ...policyApplied }));
  const space = await createSpace(run, plane, undefined, { explicitPlane: true });
  assert.equal(run.requests[0].body.media_plane, plane);
  assert.equal(space.effective_media_plane, plane);
});

test("a Space on another plane stops the run with media-plane-config", async () => {
  const run = await fakeRun(() => ({ id: "s", effective_media_plane: "cf_sfu", media_plane: "cf_sfu", ...policyApplied }));
  await assert.rejects(createSpace(run, "chalk_sfu"), (error) => error.reason === "media-plane-config" && /not chalk_sfu/.test(error.message));
});

test("an operator-moved Space is reused for its plane and checked the same way", async () => {
  process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU = "pinned";
  try {
    const run = await fakeRun((method) => ({ id: "pinned", effective_media_plane: method === "GET" ? "cf_sfu" : "chalk_sfu" }));
    await assert.rejects(createSpace(run, "chalk_sfu"), (error) => error.reason === "media-plane-config");
    assert.deepEqual(
      run.requests.map((request) => request.method),
      ["GET"],
    );
  } finally {
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU;
  }
});

test("a reused Space with other policies than the proof asked for stops the run", async () => {
  process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU = "pinned";
  try {
    const run = await fakeRun(() => ({ id: "pinned", effective_media_plane: "chalk_sfu", recording_policy: "automatic", transcription_policy: "on_demand" }));
    await assert.rejects(createSpace(run, "chalk_sfu"), (error) => error.reason === "media-plane-config" && /Recording policy automatic/.test(error.message));
    const matching = await fakeRun(() => ({ id: "pinned", effective_media_plane: "chalk_sfu", ...policyApplied }));
    assert.equal((await createSpace(matching, "chalk_sfu")).id, "pinned");
  } finally {
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU;
  }
});

test("an Episode in a reused Space is recorded in the ownership file before anything can fail", async () => {
  const run = await fakeRun((method) => (method === "GET" ? { episodes: [], pagination: { next_cursor: "" } } : { id: "e1", config_snapshot: { artifact_policy: { recording: { mode: "manual" }, transcription: { mode: "on_demand" } } } }));
  await createEpisode(run, { id: "pinned" });
  assert.deepEqual(run.ownership.episodes, [{ space_id: "pinned", id: "e1" }]);
  assert.deepEqual(JSON.parse(await readFile(`${run.directory}/ownership.json`, "utf8")).episodes, [{ space_id: "pinned", id: "e1" }]);
});

const episodeBody = { id: "e1", config_snapshot: { artifact_policy: { recording: { mode: "manual" }, transcription: { mode: "on_demand" } } } };
function busy() {
  return Object.assign(new ProofError("api", "API POST failed: HTTP 409, episode.capacity_exceeded"), { status: 409, apiCode: "episode.capacity_exceeded" });
}
// Episodes already in the Space, then Create Episode answers from `creates` one call at a time.
function spaceRun(existing, creates) {
  const waits = [];
  const ended = [];
  const run = {
    runId: "run",
    ownership: {},
    directory: undefined,
    tenantPath: "/v1/tenants/t",
    wait: async (ms) => waits.push(ms),
    apiRequest: async (method, path) => {
      if (method === "GET") return { episodes: existing, pagination: { next_cursor: "" } };
      if (path.endsWith("/end")) return ended.push(path);
      const next = creates.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { run, waits, ended };
}
async function withDirectory(run) {
  run.directory = await mkdtemp(`${tmpdir()}/proof-space-`);
  return run;
}
const pinnedSpace = { id: "pinned", metadata: {} };

test("a reused Space ends a live Episode another proof run left, and no one else's", async () => {
  const live = [
    { id: "left", status: "active", metadata: { proof_run_id: "earlier-run" } },
    { id: "foreign", status: "active", metadata: {} },
    { id: "done", status: "ended", metadata: { proof_run_id: "earlier-run" } },
    { id: "own", status: "active", metadata: { proof_run_id: "run" } },
  ];
  const { run, ended } = spaceRun(live, [episodeBody]);
  await createEpisode(await withDirectory(run), pinnedSpace);
  assert.deepEqual(ended, ["/v1/tenants/t/spaces/pinned/episodes/left/end"]);
});

test("a Space the run created is not searched for leftovers", async () => {
  const { run, ended } = spaceRun([{ id: "x", status: "active", metadata: { proof_run_id: "other" } }], [episodeBody]);
  await createEpisode(await withDirectory(run), { id: "own-space", metadata: { proof_run_id: "run" } });
  assert.deepEqual(ended, []);
});

test("Create Episode waits for a busy Space and goes through once it clears", async () => {
  const { run, waits } = spaceRun([], [busy(), busy(), episodeBody]);
  const { episode } = await createEpisode(await withDirectory(run), pinnedSpace);
  assert.equal(episode.id, "e1");
  assert.deepEqual(waits, [3000, 3000]);
});

test("a Space that stays busy for 90 seconds fails with proof-space-busy", async () => {
  const { run, waits } = spaceRun([], Array.from({ length: 40 }, busy));
  await assert.rejects(createEpisode(await withDirectory(run), pinnedSpace), (error) => error.reason === "proof-space-busy");
  assert.equal(waits.length, 30);
  assert.equal(
    waits.reduce((sum, ms) => sum + ms, 0),
    90_000,
  );
});

test("any other Create Episode failure is not retried", async () => {
  const other = Object.assign(new ProofError("api", "API POST failed: HTTP 409, idempotency.conflict"), { status: 409, apiCode: "idempotency.conflict" });
  const { run, waits } = spaceRun([], [other]);
  await assert.rejects(createEpisode(await withDirectory(run), pinnedSpace), (error) => error === other);
  assert.deepEqual(waits, []);
});

test("proof-space-busy is a public failure reason", () => {
  const lines = [];
  publicFailure("setup-or-capture", new ProofError("proof-space-busy", "private detail"), (line) => lines.push(line));
  assert.deepEqual(lines, ["PROOF setup-or-capture: failed (proof-space-busy)"]);
});

test("a Space setup mismatch keeps its bounded public reason", () => {
  const lines = [];
  publicFailure("setup-or-capture", new ProofError("media-plane-config", "private detail"), (line) => lines.push(line));
  assert.deepEqual(lines, ["PROOF setup-or-capture: failed (media-plane-config)"]);
});

test("a measured check prints its message, a nested one prints every message, and any other error stays private", () => {
  const lines = [];
  const write = (line) => lines.push(line);
  const thrown = (run) => {
    try {
      run();
    } catch (error) {
      return error;
    }
  };
  publicFailure(
    "call-artifacts",
    thrown(() => measured(false, "Transcript terminal_failure")),
    write,
  );
  const both = new AggregateError([thrown(() => measured(false, "Recording shows no live video in guest 3's tile")), thrown(() => measured(false, "Transcript is empty"))]);
  publicFailure("call-artifacts", both, write);
  publicFailure("call-artifacts", new ProofError("evidence-assertion", "raw response body excerpt"), write);
  publicFailure("call-artifacts", new ProofError("configuration", "private detail"), write);
  publicFailure("call-artifacts", new Error("https://signed.example/?sig=secret"), write);
  assert.deepEqual(lines, [
    "PROOF call-artifacts: failed (evidence-assertion): Transcript terminal_failure",
    "PROOF call-artifacts: failed (evidence-assertion): Recording shows no live video in guest 3's tile; Transcript is empty",
    "PROOF call-artifacts: failed (evidence-assertion)",
    "PROOF call-artifacts: failed (configuration)",
    "PROOF call-artifacts: failed (unknown)",
  ]);
});

// Both nightly lanes share one Tenant and one deployment. The Cloudflare lane takes the platform default and the own-SFU lane
// takes the Space an operator moved, which the workflow hands to the proof as CHALK_PROOF_SPACE_ID_CHALK_SFU.
test("the Cloudflare lane and the own-SFU lane each land on their own plane", async () => {
  const workflow = readFileSync(new URL("../../.github/workflows/real-call-proof.yml", import.meta.url), "utf8");
  for (const name of ["CHALK_PROOF_SPACE_ID_CF_SFU", "CHALK_PROOF_SPACE_ID_CHALK_SFU", "CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC"]) {
    assert.equal(workflow.split(`${name}: \${{ secrets.${name} }}`).length - 1, 2, `${name} reaches both the proofs step and the latency step`);
  }
  const deployment = (method) => (method === "GET" ? { id: "chalk-space", effective_media_plane: "chalk_sfu", ...policyApplied } : { id: "new", effective_media_plane: "cf_sfu", ...policyApplied });
  const cloudflareLane = await fakeRun(deployment);
  assert.equal((await createSpace(cloudflareLane, cloudflare)).effective_media_plane, cloudflare);
  process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU = "chalk-space";
  try {
    const ownSfuLane = await fakeRun(deployment);
    assert.equal((await createSpace(ownSfuLane, "chalk_sfu")).id, "chalk-space");
    assert.equal((await createSpace(ownSfuLane, "cf_sfu")).effective_media_plane, "cf_sfu");
  } finally {
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU;
  }
});

test("the automatic-policy proof reuses its own Space and never the manual one", async () => {
  const automatic = { recording: "automatic", transcription: "automatic" };
  process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU = "manual-space";
  process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC = "automatic-space";
  try {
    const run = await fakeRun((method) => ({ id: method === "GET" ? "automatic-space" : "created", effective_media_plane: "chalk_sfu", recording_policy: "automatic", transcription_policy: "automatic" }));
    assert.equal((await createSpace(run, "chalk_sfu", automatic)).id, "automatic-space");
    assert.match(run.requests[0].path, /spaces\/automatic-space$/);
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC;
    await assert.rejects(
      createSpace(await fakeRun(() => ({ id: "created", effective_media_plane: "cf_sfu", recording_policy: "automatic", transcription_policy: "automatic" })), "chalk_sfu", automatic),
      (error) => error.reason === "media-plane-config" && /CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC/.test(error.message),
    );
  } finally {
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU;
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC;
  }
});

test("Promote's own-SFU proof finds its Space by slug and never creates one", async () => {
  process.env.CHALK_PROOF_SPACE_BY_SLUG = "true";
  try {
    const found = { id: "s", slug: "promote-proof-chalk-sfu", media_plane: "chalk_sfu", ...policyApplied };
    const run = await fakeRun((method) => (method === "GET" ? { spaces: [found], pagination: { next_cursor: "" } } : assert.fail("created a Space")));
    assert.equal((await createSpace(run, "chalk_sfu")).id, "s");
    assert.deepEqual(
      run.requests.map((request) => request.method),
      ["GET"],
    );
    const missing = await fakeRun(() => ({ spaces: [], pagination: { next_cursor: "" } }));
    await assert.rejects(createSpace(missing, "chalk_sfu"), (error) => error.reason === "media-plane-config" && /own-sfu-spaces/.test(error.message));
  } finally {
    delete process.env.CHALK_PROOF_SPACE_BY_SLUG;
  }
});

test("Promote's own-SFU proof uses the Space an operator pinned, the same one the ensure step checks", async () => {
  process.env.CHALK_PROOF_SPACE_BY_SLUG = "true";
  process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU = "pinned";
  try {
    const run = await fakeRun((method) => (method === "GET" ? { id: "pinned", slug: "operator-space", media_plane: "chalk_sfu", ...policyApplied } : assert.fail("created a Space")));
    assert.equal((await createSpace(run, "chalk_sfu")).id, "pinned");
    assert.deepEqual(
      run.requests.map((request) => request.path),
      ["/v1/tenants/t/spaces/pinned"],
    );
  } finally {
    delete process.env.CHALK_PROOF_SPACE_BY_SLUG;
    delete process.env.CHALK_PROOF_SPACE_ID_CHALK_SFU;
  }
});
