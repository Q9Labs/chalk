import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { ProofError, publicFailure } from "./runtime.mjs";

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

const policyApplied = { recording_policy: "manual", transcription_policy: "on_demand" };

test("a proof Space is created without naming a plane and must be on the requested one", async () => {
  const run = await fakeRun(() => ({ id: "s", effective_media_plane: "chalk_sfu", media_plane: "cf_sfu", ...policyApplied }));
  const space = await createSpace(run, "chalk_sfu");
  assert.equal(space.id, "s");
  assert.equal("media_plane" in run.requests[0].body, false);
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
  const run = await fakeRun(() => ({ id: "e1", config_snapshot: { artifact_policy: { recording: { mode: "manual" }, transcription: { mode: "on_demand" } } } }));
  await createEpisode(run, { id: "pinned" });
  assert.deepEqual(run.ownership.episodes, [{ space_id: "pinned", id: "e1" }]);
  assert.deepEqual(JSON.parse(await readFile(`${run.directory}/ownership.json`, "utf8")).episodes, [{ space_id: "pinned", id: "e1" }]);
});

test("a Space setup mismatch keeps its bounded public reason", () => {
  const lines = [];
  publicFailure("setup-or-capture", new ProofError("media-plane-config", "private detail"), (line) => lines.push(line));
  assert.deepEqual(lines, ["PROOF setup-or-capture: failed (media-plane-config)"]);
});

// Both nightly lanes share one Tenant and one deployment. The Cloudflare lane takes the platform default and the own-SFU lane
// takes the Space an operator moved, which the workflow hands to the proof as CHALK_PROOF_SPACE_ID_CHALK_SFU.
test("the Cloudflare lane and the own-SFU lane each land on their own plane", async () => {
  const workflow = readFileSync(new URL("../../.github/workflows/real-call-proof.yml", import.meta.url), "utf8");
  for (const name of ["CHALK_PROOF_SPACE_ID_CF_SFU", "CHALK_PROOF_SPACE_ID_CHALK_SFU", "CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC"]) {
    assert.equal(workflow.split(`${name}: \${{ vars.${name} }}`).length - 1, 2, `${name} reaches both the proofs step and the latency step`);
  }
  const deployment = (method) => (method === "GET" ? { id: "chalk-space", effective_media_plane: "chalk_sfu", ...policyApplied } : { id: "new", effective_media_plane: "cf_sfu", ...policyApplied });
  const cloudflareLane = await fakeRun(deployment);
  assert.equal((await createSpace(cloudflareLane, "cf_sfu")).effective_media_plane, "cf_sfu");
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
