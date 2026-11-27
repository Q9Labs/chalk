import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const build = JSON.parse(await read("./preview-build.json"));
const manifest = JSON.parse(await read("../package.json"));
const workspace = await read("../../pnpm-workspace.yaml");
const lockfile = await read("../../pnpm-lock.yaml");
assert.match(build.commit, /^[a-f0-9]{40}$/, "Preview must identify one full upstream commit");
// pkg.alchemy.run dropped this preview, so the graph installs from our own release mirror; the lockfile integrity authenticates each tarball.
assert.match(build.mirror, /^https:\/\/github\.com\/Q9Labs\/chalk\/releases\/download\/vendor-alchemy-[a-f0-9]{7}\/$/, "Mirror must be a Chalk vendor release");
assert.ok(build.mirror.includes(build.commit.slice(0, 7)), "Mirror tag must name the preview commit");
for (const [name, url] of Object.entries(build.packages)) {
  assert.ok(url.startsWith(build.mirror) && url.endsWith(".tgz"), `${name}: tarball must come from the mirror`);
  assert.ok(workspace.split("\n").includes(`  "${name}": ${url}`), `${name}: override must match the preview build`);
  assert.ok(
    lockfile.split("\n").some((line) => line.includes(`tarball: ${url}`) && /integrity: sha512-[A-Za-z0-9+/=]+/.test(line)),
    `${name}: lockfile must authenticate the tarball`,
  );
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
    const response = await fetch(url, { method: "HEAD" });
    assert.ok(response.ok, `${name}: mirrored tarball unavailable`);
  }
}
console.log(`Alchemy preview graph pinned to ${build.commit} (${Object.keys(build.packages).length} packages)`);
