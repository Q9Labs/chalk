#!/usr/bin/env node
// The proofs `pnpm prod:proof` runs, read from registry.json by index.mjs, scripts/staging-sfu/run-proofs and real-call-proof.yml.
//
//   registry.mjs check <media-plane> <proof>...   exits 1 when the plane or a proof is not supported
//   registry.mjs lane <proof>                     prints "own" for a proof with its own Space, otherwise "shared"
import registry from "./registry.json" with { type: "json" };

export const proofNames = Object.keys(registry);
export const proofDescription = (name) => registry[name].description;

export function proofPlan(name) {
  const { flags, proofs } = registry[name];
  return { media: false, webhooks: false, ...flags, proofs };
}

export const dryRunNames = proofNames.filter((name) => registry[name].dryRun);
export const noBrowserNames = proofNames.filter((name) => registry[name].browser === false);

export function unsupportedOnPlane(plane, names) {
  return names.filter((name) => !registry[name]?.planes.includes(plane));
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "check") {
    const [plane, ...names] = args;
    const unknown = names.filter((name) => !registry[name]);
    if (!["cf_sfu", "chalk_sfu"].includes(plane)) fail("Unsupported media plane");
    if (names.length === 0) fail("PROOF configuration: failed (empty-proof-list)");
    if (unknown.length > 0) fail(`Unsupported proof command: ${unknown.join(" ")}`);
    const unsupported = unsupportedOnPlane(plane, names);
    if (unsupported.length > 0) {
      const supported = proofNames.filter((name) => registry[name].planes.includes(plane));
      fail(`${plane} supports only ${supported.join(", ")}; not ${unsupported.join(", ")}`);
    }
  } else if (command === "lane" && registry[args[0]]) {
    console.log(registry[args[0]].ownSpace ? "own" : "shared");
  } else fail("usage: registry.mjs check <media-plane> <proof>... | lane <proof>");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
