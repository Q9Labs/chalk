import { check, ProofError } from "./runtime.mjs";

// The two proof Spaces Promote reuses on the Chalk SFU. The public API of a release with the per-Space
// setting refuses chalk_sfu, so they must reach chalk_sfu BEFORE that release deploys: the previous
// release lets the public API set it on an allowlisted Space, and a plane stored that way survives the
// upgrade. They are found by slug, so no Space ID lives in a variable or a log.
export const manualPolicy = { recording: "manual", transcription: "on_demand" };
const automaticPolicy = { recording: "automatic", transcription: "automatic" };
export const chalkSfuSpaces = {
  manual: { slug: "promote-proof-chalk-sfu", policy: manualPolicy },
  automatic: { slug: "promote-proof-chalk-sfu-automatic", policy: automaticPolicy },
};

// The release before the per-Space setting has no effective_media_plane.
export const spacePlane = (space) => space.effective_media_plane ?? space.media_plane;

export function chalkSfuSpaceKind(policy) {
  if (policy.recording === manualPolicy.recording && policy.transcription === manualPolicy.transcription) return "manual";
  if (policy.recording === automaticPolicy.recording && policy.transcription === automaticPolicy.transcription) return "automatic";
  return undefined;
}

async function findSpaceBySlug(apiRequest, tenantPath, slug) {
  let cursor = "";
  do {
    const query = new URLSearchParams({ page_size: "100", cursor });
    const page = await apiRequest("GET", `${tenantPath}/spaces?${query}`);
    check(Array.isArray(page.spaces), "Invalid Space listing");
    const found = page.spaces.find((space) => space.slug === slug && !space.archived);
    if (found) return found;
    cursor = (page.pagination ?? page.page)?.next_cursor ?? "";
  } while (cursor);
  return undefined;
}

function checkPolicy(space, { slug, policy }) {
  check(space.recording_policy === policy.recording && space.transcription_policy === policy.transcription, `The proof Space ${slug} has other Recording or Transcription policies than the proof needs`, "media-plane-config");
}

// The Space an operator pinned for this kind (CHALK_PROOF_SPACE_ID_CHALK_SFU, or the _AUTOMATIC one), if any.
const pinVariable = (kind) => (kind === "manual" ? "CHALK_PROOF_SPACE_ID_CHALK_SFU" : "CHALK_PROOF_SPACE_ID_CHALK_SFU_AUTOMATIC");

// The one Space this run proves on for `kind`: the pinned one when an operator pinned it, otherwise the one with the
// fixed slug. The ensure step and the proof both resolve it here, so the proof runs on the Space the step checked.
export async function findChalkSfuSpace(apiRequest, tenantPath, kind) {
  const pinned = process.env[pinVariable(kind)];
  if (pinned) {
    try {
      return await apiRequest("GET", `${tenantPath}/spaces/${pinned}`);
    } catch (error) {
      if (error.status === 404) return undefined;
      throw error;
    }
  }
  return findSpaceBySlug(apiRequest, tenantPath, chalkSfuSpaces[kind].slug);
}

async function ensureOne(run, kind) {
  const wanted = chalkSfuSpaces[kind];
  const path = `${run.tenantPath}/spaces`;
  const pinned = Boolean(process.env[pinVariable(kind)]);
  let space = await findChalkSfuSpace(run.apiRequest, run.tenantPath, kind);
  if (pinned && !space) {
    const message = `${pinVariable(kind)} names a Space that does not exist: unset it or fix it`;
    console.error(message);
    throw new ProofError("media-plane-config", message);
  }
  space ??= await run.apiRequest("POST", path, {
    name: wanted.slug,
    slug: wanted.slug,
    recording_policy: wanted.policy.recording,
    transcription_policy: wanted.policy.transcription,
    default_episode_duration_seconds: 1800,
    maximum_episode_duration_seconds: 1800,
    linger_window_seconds: 60,
    admission_policy: { mode: "open" },
  });
  checkPolicy(space, wanted);
  if (spacePlane(space) !== "chalk_sfu") {
    try {
      space = await run.apiRequest("PATCH", `${path}/${space.id}`, { media_plane: "chalk_sfu" });
    } catch (error) {
      if (!(error instanceof ProofError) || ![400, 403].includes(error.status)) throw error;
      // The proof's log shows only the failure reason, and the operator needs the Space to act on. A fixed slug is not an identifier.
      const message = `The API refused chalk_sfu for the proof Space ${wanted.slug} (${error.apiCode}). Before the per-Space setting: add this Space to CHALK_SFU_ALLOWED_SPACES, then run this step again. After it: run media-settings set --plane chalk_sfu for this Space`;
      console.error(message);
      throw new ProofError("media-plane-config", message);
    }
  }
  check(spacePlane(space) === "chalk_sfu", `The proof Space ${wanted.slug} is on ${spacePlane(space)}, not chalk_sfu`, "media-plane-config");
  console.log(`Proof Space ${wanted.slug} is on chalk_sfu`);
  return { slug: wanted.slug, plane: "chalk_sfu" };
}

export async function ensureChalkSfuSpaces(run) {
  return { manual: await ensureOne(run, "manual"), automatic: await ensureOne(run, "automatic") };
}
