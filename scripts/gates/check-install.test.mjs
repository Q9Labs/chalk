import assert from "node:assert/strict";
import test from "node:test";
import { installMismatches, rootLockedVersions } from "./check-install.mjs";

const lockfile = `importers:

  .:
    dependencies:
      react:
        specifier: 19.2.7
        version: 19.2.7
    devDependencies:
      '@q9labsai/gates':
        specifier: https://example.invalid/q9labsai-gates-0.3.0.tgz
        version: https://example.invalid/q9labsai-gates-0.3.0.tgz(peer@1.0.0)
      typescript-7:
        specifier: npm:typescript@7.0.1-rc
        version: typescript@7.0.1-rc

  apps/web:
    dependencies:
      other:
        specifier: 1.0.0
        version: 1.0.0
`;

test("reads only the root importer", () => {
  assert.deepEqual(
    rootLockedVersions(lockfile).map(({ name }) => name),
    ["react", "@q9labsai/gates", "typescript-7"],
  );
});

test("reads real dependencies after pnpm 12's package-manager document", () => {
  const pnpm12Lockfile = `---
lockfileVersion: '9.0'
importers:
  .:
    configDependencies: {}
    packageManagerDependencies:
      pnpm:
        specifier: 12.8.1
        version: 12.8.1
packages:
  pnpm@12.8.1:
    resolution: {}
---
${lockfile}`;
  assert.deepEqual(rootLockedVersions(pnpm12Lockfile), rootLockedVersions(lockfile));
  assert.deepEqual(
    installMismatches(rootLockedVersions(pnpm12Lockfile), () => undefined),
    ["react: locked 19.2.7, not installed", "@q9labsai/gates: locked https://example.invalid/q9labsai-gates-0.3.0.tgz, not installed", "typescript-7: locked 7.0.1-rc, not installed"],
  );
  assert.match(installMismatches(rootLockedVersions(pnpm12Lockfile), () => "0.0.0")[0], /react: locked 19.2.7, installed 0.0.0/);
});

test("ignores configuration dependencies but checks optional dependencies", () => {
  assert.deepEqual(
    rootLockedVersions(`importers:
  .:
    configDependencies:
      config:
        version: 1.0.0
    optionalDependencies:
      optional:
        version: 2.0.0
packages:
  unrelated:
    dependencies:
      other:
        version: 3.0.0
`),
    [{ name: "optional", version: "2.0.0" }],
  );
});

test("compares an npm alias with its target version", () => {
  const alias = rootLockedVersions(lockfile).find(({ name }) => name === "typescript-7");
  assert.equal(alias.version, "7.0.1-rc");
  assert.deepEqual(
    installMismatches([alias], () => "7.0.1-rc"),
    [],
  );
});

test("reports stale, missing, and matching packages", () => {
  const installed = { react: "19.2.7", "@q9labsai/gates": "0.1.0", "typescript-7": "7.0.1-rc" };
  const problems = installMismatches(rootLockedVersions(lockfile), (name) => installed[name]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /@q9labsai\/gates: locked .*0\.3\.0\.tgz, installed 0\.1\.0/);
  assert.deepEqual(
    installMismatches(rootLockedVersions(lockfile), (name) => ({ react: "19.2.7", "@q9labsai/gates": "0.3.0", "typescript-7": "7.0.1-rc" })[name]),
    [],
  );
});
