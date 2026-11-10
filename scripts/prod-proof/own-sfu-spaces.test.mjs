import assert from "node:assert/strict";
import test from "node:test";
import { ProofError } from "./runtime.mjs";
import { ensureOwnSfuSpaces, ownSfuSpaceKind, ownSfuSpaces, spacePlane } from "./own-sfu-spaces.mjs";

// A tenant with the two proof Spaces, as the release before the per-Space setting serves them (media_plane only).
function fakeApi({ spaces = [], refuse = false } = {}) {
  const calls = [];
  const apiRequest = async (method, path, body) => {
    calls.push([method, path.replace(/\?.*/, ""), body]);
    if (method === "GET") return { spaces, pagination: { next_cursor: "" } };
    if (method === "POST") {
      const created = { id: `space-${spaces.length}`, slug: body.slug, media_plane: "cf_sfu", recording_policy: body.recording_policy, transcription_policy: body.transcription_policy };
      spaces.push(created);
      return created;
    }
    if (refuse) throw Object.assign(new ProofError("api", "API PATCH failed"), { status: 400, apiCode: "space.invalid_media_plane" });
    const space = spaces.find((entry) => path.endsWith(`/${entry.id}`));
    space.media_plane = body.media_plane;
    return space;
  };
  return { apiRequest, calls, spaces };
}
const run = (api) => ({ apiRequest: api.apiRequest, tenantPath: "/v1/tenants/t" });

test("creates both proof Spaces with their policies and moves them to chalk_sfu", async () => {
  const api = fakeApi();
  await ensureOwnSfuSpaces(run(api));
  assert.deepEqual(
    api.spaces.map((space) => [space.slug, space.media_plane, space.recording_policy, space.transcription_policy]),
    [
      ["promote-proof-chalk-sfu", "chalk_sfu", "manual", "on_demand"],
      ["promote-proof-chalk-sfu-automatic", "chalk_sfu", "automatic", "automatic"],
    ],
  );
});

test("a second run changes nothing", async () => {
  const api = fakeApi();
  await ensureOwnSfuSpaces(run(api));
  const before = api.calls.length;
  await ensureOwnSfuSpaces(run(api));
  assert.deepEqual(
    api.calls.slice(before).map(([method]) => method),
    ["GET", "GET"],
  );
});

test("a refused move names the Space and the operator step, and no Space ID", async () => {
  const api = fakeApi({ refuse: true });
  await assert.rejects(ensureOwnSfuSpaces(run(api)), (error) => error.reason === "media-plane-config" && /promote-proof-chalk-sfu/.test(error.message) && /CHALK_SFU_ALLOWED_SPACES/.test(error.message) && !error.message.includes("space-0"));
});

test("a Space with other policies is refused", async () => {
  const api = fakeApi({ spaces: [{ id: "x", slug: "promote-proof-chalk-sfu", media_plane: "chalk_sfu", recording_policy: "automatic", transcription_policy: "automatic" }] });
  await assert.rejects(ensureOwnSfuSpaces(run(api)), /other Recording or Transcription policies/);
});

test("policy sets map to their slug and the new response field wins over the old one", () => {
  assert.equal(ownSfuSpaceKind({ recording: "manual", transcription: "on_demand" }), "manual");
  assert.equal(ownSfuSpaceKind({ recording: "automatic", transcription: "automatic" }), "automatic");
  assert.equal(ownSfuSpaceKind({ recording: "manual", transcription: "automatic" }), undefined);
  assert.equal(ownSfuSpaces.manual.slug, "promote-proof-chalk-sfu");
  assert.equal(spacePlane({ media_plane: "chalk_sfu", effective_media_plane: "cf_sfu" }), "cf_sfu");
});
