#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

async function filesIn(root, current = root) {
  const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await filesIn(root, path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

async function digest(path) {
  const bytes = await readFile(path);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}

const staging = resolve(argument("--staging"));
const zipPath = resolve(argument("--zip"));
const artifactSha256 = argument("--sha256");
const releaseId = argument("--release-id");
const sourceRevision = argument("--source-revision");
const sourceState = argument("--source-state");
const sourceTreeDigest = process.argv.includes("--source-tree-digest") ? argument("--source-tree-digest") : undefined;
const sourceDateEpoch = Number(argument("--source-date-epoch"));
const outputDir = resolve(argument("--output-dir"));

if (!/^[0-9a-f]{64}$/.test(artifactSha256)) throw new Error("artifact SHA-256 must be 64 lowercase hexadecimal characters");
if (sourceState !== "clean" && sourceState !== "dirty-local-proof") throw new Error("source state must be clean or dirty-local-proof");
if (sourceState === "dirty-local-proof" && !/^[0-9a-f]{64}$/.test(sourceTreeDigest ?? "")) throw new Error("dirty-local-proof requires a source tree digest");
if (!Number.isSafeInteger(sourceDateEpoch) || sourceDateEpoch < 0) throw new Error("source date epoch must be a non-negative integer");

const files = [];
for (const path of await filesIn(staging)) {
  files.push({ path: relative(staging, path).split("\\").join("/"), ...(await digest(path)) });
}
const zip = await digest(zipPath);
if (zip.sha256 !== artifactSha256) throw new Error(`ZIP digest changed while generating manifest: expected ${artifactSha256}, got ${zip.sha256}`);
const artifactSha256Base64 = Buffer.from(artifactSha256, "hex").toString("base64");

const stem = basename(zipPath, ".zip");
const sbom = {
  schema: "chalk.transcription-dispatcher.sbom.v1",
  release_id: releaseId,
  artifact_sha256: artifactSha256,
  components: files.map((file) => ({ name: `lambda/${file.path}`, type: "file", sha256: file.sha256, size: file.size })),
};
const provenance = {
  schema: "chalk.transcription-dispatcher.provenance.v1",
  release_id: releaseId,
  source_revision: sourceRevision,
  source_state: sourceState,
  ...(sourceTreeDigest === undefined ? {} : { source_tree_digest: sourceTreeDigest }),
  source_date_epoch: sourceDateEpoch,
  builder: "scripts/transcription-dispatcher/build-release.sh",
  build_command: "pnpm --dir apps/transcription-dispatcher build",
  artifact: { filename: basename(zipPath), sha256: artifactSha256, sha256_base64: artifactSha256Base64, size: zip.size },
};
await writeFile(join(outputDir, `${stem}.sbom.json`), `${JSON.stringify(sbom, null, 2)}\n`);
await writeFile(join(outputDir, `${stem}.provenance.json`), `${JSON.stringify(provenance, null, 2)}\n`);
const sbomDigest = await digest(join(outputDir, `${stem}.sbom.json`));
const provenanceDigest = await digest(join(outputDir, `${stem}.provenance.json`));
const manifest = {
  schema: "chalk.transcription-dispatcher.release-manifest.v1",
  release_id: releaseId,
  source_revision: sourceRevision,
  source_state: sourceState,
  ...(sourceTreeDigest === undefined ? {} : { source_tree_digest: sourceTreeDigest }),
  source_date_epoch: sourceDateEpoch,
  artifact: { filename: basename(zipPath), sha256: artifactSha256, sha256_base64: artifactSha256Base64, size: zip.size },
  sbom: { filename: `${stem}.sbom.json`, sha256: sbomDigest.sha256 },
  provenance: { filename: `${stem}.provenance.json`, sha256: provenanceDigest.sha256 },
  files,
};
await writeFile(join(outputDir, `${stem}.manifest.json`), `${JSON.stringify(manifest, null, 2)}\n`);
