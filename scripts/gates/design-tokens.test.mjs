import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { compareBaseline, findTokenViolations } from "../../sdks/typescript/react/scripts/check-token-reach.mjs";

test("React token check finds each raw color and palette utility without flagging token names", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chalk-react-tokens-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const component = join(root, "example.tsx");
  await writeFile(component, 'const good = "placeholder:text-[var(--chalk-app-text-muted,var(--chalk-muted-text))] ring-offset-2 focus-visible:ring-offset-1";\nconst bad = "#fff #000 bg-blue-500";\n');
  const violations = await findTokenViolations(root);
  assert.deepEqual(violations.map(({ value }) => value).sort(), ["#000", "#fff", "bg-blue-500"].sort());

  const baseline = violations.map(({ fingerprint }) => ({ fingerprint, count: 1 }));
  assert.deepEqual(compareBaseline(violations, baseline), { added: [], removed: 0 });
  await writeFile(component, 'const good = "placeholder:text-[var(--chalk-app-text-muted,var(--chalk-muted-text))] ring-offset-2 focus-visible:ring-offset-1";\nconst bad = "#fff #000 bg-blue-500";\nconst another = "bg-blue-500";\n');
  const result = compareBaseline(await findTokenViolations(root), baseline);
  assert.equal(result.added.length, 1, "existing debt must not hide a new occurrence");
  assert.equal(result.removed, 0);
});

test("React Native token check catches raw colors while allowing theme tokens and currentColor", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "chalk-native-tokens-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  const component = join(root, "src", "example.tsx");
  const scanner = resolve("sdks/typescript/react-native/scripts/check-tokenized-styles.mjs");
  const run = () => spawnSync(process.execPath, [scanner], { cwd: root, encoding: "utf8" });
  await writeFile(component, 'const style = { color: tokens.text, backgroundColor: "hsl(1, 2%, 3%)" };\nconst icon = <Icon fill="red" />;\n');
  const bad = run();
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /hsl\(1, 2%, 3%\)/u);
  assert.match(bad.stderr, /fill="red"/u);
  await writeFile(component, 'const style = { color: tokens.text };\nconst icon = <Icon fill="currentColor" stroke="none" />;\n');
  assert.equal(run().status, 0);
});
