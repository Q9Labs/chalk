import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const build = JSON.parse(await read("./preview-build.json"));
const manifest = JSON.parse(await read("../package.json"));
const workspace = await read("../../pnpm-workspace.yaml");
const lockfile = await read("../../pnpm-lock.yaml");
assert.match(build.commit, /^[a-f0-9]{40}$/, "Preview must identify one full upstream commit");
for (const [name, url] of Object.entries(build.packages)) {
  assert.match(url, /^https:\/\/pkg\.alchemy\.run\/[^\s]+\/-\/[a-f0-9]{64}\.tgz$/, `${name}: immutable tarball required`);
  assert.ok(workspace.split("\n").includes(`  "${name}": ${url}`), `${name}: override must match the preview build`);
  assert.ok(lockfile.split("\n").some((line) => line.includes(`tarball: ${url}`) && /integrity: sha512-[A-Za-z0-9+/=]+/.test(line)), `${name}: lockfile must authenticate the tarball`);
}
for (const [name, version] of Object.entries(manifest.dependencies)) {
  if (name === "alchemy" || name.startsWith("@alchemy.run/") || name.startsWith("@distilled.cloud/")) {
    assert.equal(version, build.packages[name], `${name}: partial Alchemy bumps are forbidden; update preview-build.json and the whole graph together`);
  }
}
assert.equal(manifest.dependencies.effect, "4.1.4", "Use one Effect runtime throughout the infrastructure graph");
assert.ok(workspace.includes('  "effect@^4.1.4": 4.1.4'), "Pin transitive infrastructure Effect peers too");
if (process.argv.includes("--verify-source")) {
  for (const [name, url] of Object.entries(build.packages)) {
    const response = await fetch(`https://pkg.alchemy.run/${name}/${build.commit}`, { method: "HEAD" });
    assert.ok(response.ok, `${name}: upstream preview unavailable`);
    assert.equal(response.url, url, `${name}: tarball does not belong to the recorded commit`);
  }
}
console.log(`Alchemy preview graph pinned to ${build.commit} (${Object.keys(build.packages).length} packages)`);
