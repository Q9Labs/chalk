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
