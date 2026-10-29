// Run on an installed/compiled tree. Each fixture must fail the named policy,
// not merely fail compilation, and is removed even when a command fails.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const language = process.argv[2];
const command = language === "typescript" ? ["pnpm", "exec", "depcruise", "--config", ".dependency-cruiser.cjs", "--output-type", "err", "features/whiteboard"] : ["node", "scripts/features/check.mjs", language];
const run = (args, cwd = root) => {
  console.log(`$ ${args.join(" ")}`);
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8", env: { ...process.env, MIX_ENV: "test" } });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  console.log(output.trim());
  if (result.error) throw result.error;
  return { ...result, output };
};
const compile = () => {
  const result = run(["mix", "compile", "--warnings-as-errors"], path.join(root, "apps/sync"));
  assert.equal(result.status, 0, "fixture must compile before testing the Elixir dependency policy");
};
const fixtures = {
  go: ["features/whiteboard/api/manifest_violation.go", 'package whiteboardfiles\nimport _ "github.com/q9labs/chalk/platform/ratelimit"\n'],
  typescript: ["features/whiteboard/sdk/client/src/manifest-violation.ts", 'import "@q9labsai/recording-presentation";\n'],
  elixir: ["features/whiteboard/sync/lib/chalk_sync/whiteboard_v1/manifest_violation.ex", "defmodule ChalkSync.WhiteboardV1.ManifestViolation do\n  def violation, do: ChalkSync.Chat.Postgres.__info__(:functions)\nend\n"],
};
assert.ok(Object.hasOwn(fixtures, language), "Usage: node scripts/features/demo.mjs go|typescript|elixir");
if (language === "elixir") compile();
assert.equal(run(command).status, 0, "real tree must pass before the violation");
const [relative, content] = fixtures[language];
const fixture = path.join(root, relative);
try {
  writeFileSync(fixture, content, { flag: "wx" });
  if (language === "elixir") compile();
  const rejected = run(command);
  assert.equal(rejected.status, 1, "deliberate dependency must fail the policy");
  assert.match(rejected.output, language === "typescript" ? /whiteboard-declared-dependencies/ : /imports undeclared/);
} finally {
  unlinkSync(fixture);
  if (language === "elixir") compile();
}
assert.equal(run(command).status, 0, "real tree must pass after fixture removal");
console.log(`${language}: violation rejected; clean tree passed before and after`);
if (language === "go") {
  const privateImport = path.join(root, "apps/api/cmd/private_import_violation.go");
  try {
    writeFileSync(privateImport, 'package main\nimport _ "github.com/q9labs/chalk/features/whiteboard/api/internal/files"\n', { flag: "wx" });
    const rejected = run(["go", "list", "./apps/api/cmd"]);
    assert.equal(rejected.status, 1);
    assert.match(rejected.output, /use of internal package .* not allowed/);
  } finally {
    unlinkSync(privateImport);
  }
  console.log("Go compiler rejects an API consumer of feature-private implementation");
}
