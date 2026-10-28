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

async function fixture(t, files) {
  const root = await mkdtemp(join(tmpdir(), "chalk-token-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(join(root, name, ".."), { recursive: true });
    await writeFile(join(root, name), source);
  }
  return root;
}

test("React permits Tailwind 4 token opacity, fallbacks, shorthand, currentColor, SVG IDs and comments", async (t) => {
  const root = await fixture(t, {
    "valid.tsx": `// bg-blue-500 #fff color: red
/* var(--primary) #123456 */
const css = \`/* color: red; #fff */ .x { color: currentColor; background: transparent; fill: url(#abc); }\`;
const element = <a href="#abc" id="abc" className="bg-[var(--chalk-app-danger)]/10 border-[var(--chalk-app-danger)]/35 hover:!bg-[var(--chalk-overlay)]/[.14] text-(--chalk-text) ring-offset-2 focus-visible:ring-offset-1 placeholder:text-[var(--chalk-app-text-muted,var(--chalk-muted-text))]" />;
const url = "https://example.test/#fff";
const pattern = /#fff/;
`,
  });
  assert.deepEqual(await findTokenViolations(root), []);
});

test("React detects named colors, modern functions and extended utility families without corrupting locations", async (t) => {
  const root = await fixture(t, {
    "modern.tsx": `const tokens = "bg-[var(--chalk-text)]";
const css = \`.x { color: rebeccapurple; background: oklch(50% .2 30); }\`;
const bad = <svg fill={"navy"} className="focus-visible:ring-offset-red-500 outline-blue-500 shadow-black/20 from-red-500 via-blue-500 to-green-500 border-t-red-500 decoration-red-500 divide-red-500 accent-red-500 caret-red-500" />;
const legacy = "text-[var(--chalk-text)] var(--foreground)";
`,
    "ignored.test.tsx": `const fixture = "#fff bg-white";`,
    "nested/extra.css": `/* #fff */ .x { color: #1234; }`,
  });
  const found = await findTokenViolations(root);
  assert.equal(found.filter(({ rule }) => rule === "palette-utility").length, 11);
  assert.deepEqual(
    found.filter(({ rule }) => rule === "named-color").map(({ value }) => value),
    ["color: rebeccapurple", 'fill={"navy"'],
  );
  assert.ok(found.some(({ value, line }) => value === "oklch(" && line === 2));
  assert.ok(found.some(({ value, line }) => value === "var(--foreground)" && line === 4));
  assert.ok(found.some(({ file, value }) => file === "nested/extra.css" && value === "#1234"));
});

test("exceptions are exact, single-use and do not hide neighboring or duplicate colors", async (t) => {
  const snippet = 'const qr = <path fill="#000" />;';
  const root = await fixture(t, { "qr.tsx": snippet + '\nconst bad = "#fff";' });
  const exceptions = [{ file: "qr.tsx", snippet, reason: "Fixed QR contrast" }];
  assert.deepEqual(
    (await findTokenViolations(root, exceptions)).map(({ value, line }) => ({ value, line })),
    [{ value: "#fff", line: 2 }],
  );
  await writeFile(join(root, "qr.tsx"), snippet + "\n" + snippet);
  await assert.rejects(findTokenViolations(root, exceptions), /exactly once/u);
  await writeFile(join(root, "qr.tsx"), 'const qr = <path fill="#111" />;');
  await assert.rejects(findTokenViolations(root, exceptions), /exactly once/u);
});

test("baseline accounting rejects stale and duplicate occurrences", () => {
  const violation = { fingerprint: "same" };
  assert.deepEqual(compareBaseline([violation, violation], [{ fingerprint: "same", count: 1 }]), { added: [violation], removed: 0 });
  assert.deepEqual(compareBaseline([], [{ fingerprint: "same", count: 2 }]), { added: [], removed: 2 });
});

test("Native detects quoted properties, JSX expressions, named colors and modern functions but ignores comments", async (t) => {
  const root = await fixture(t, {
    "src/example.tsx": `// color: "red"
const style = { "backgroundColor": "oklch(50% .2 30)", tintColor: "rebeccapurple" };
const icon = <Icon fill={"navy"} stroke="currentColor" />;
`,
  });
  const result = spawnSync(process.execPath, [resolve("sdks/typescript/react-native/scripts/check-tokenized-styles.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /oklch\(/u);
  assert.match(result.stderr, /rebeccapurple/u);
  assert.match(result.stderr, /navy/u);
  assert.doesNotMatch(result.stderr, /:1:/u);
});
