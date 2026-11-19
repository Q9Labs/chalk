import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isDeepStrictEqual } from "node:util";
import * as Schema from "effect/Schema";
import { entryFile, stacks } from "../registry.ts";

// Compare every transitive declaration, not one chosen set of fixture inputs.
// Equality of the executable AST and dependency edges proves equal resource
// graphs for the same inputs/cloud reads. No stack program or provider runs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const base = process.argv[2];
if (!base || process.argv.length !== 3) throw new Error("Usage: tsx migration/check-definitions.ts <before-commit>");
const moves = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)))(readFileSync(new URL("structure-moves.json", import.meta.url), "utf8"));
const originalPath = (path: string) => Object.entries(moves).find(([, current]) => current === path)?.[0] ?? path;
const currentPath = (path: string) => moves[path] ?? path;
function ast(node: ts.Node): Schema.Json {
  const children: Schema.Json[] = [];
  ts.forEachChild(node, (child) => { children.push(ast(child)); });
  const text = ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node) || ts.isRegularExpressionLiteral(node) || ts.isBigIntLiteral(node) ? node.text : null;
  const flags = ts.isVariableDeclarationList(node) ? node.flags & ts.NodeFlags.BlockScoped : 0;
  return [node.kind, flags, text, children];
}
const parse = (path: string, source: string) => ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const oldSource = (path: string) => execFileSync("git", ["show", `${base}:${path}`], { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
const newSource = (path: string) => readFileSync(resolve(root, path), "utf8");
function configInitializer(component: string, name: string) {
  const path = `infrastructure/${component}/config.ts`;
  const file = parse(path, newSource(path));
  const statements = file.statements.filter((node) => !ts.isImportDeclaration(node));
  assert.equal(statements.length, 1, `${path}: unexpected executable config statement`);
  const statement = statements[0];
  assert.ok(statement && ts.isVariableStatement(statement));
  assert.equal(statement.declarationList.declarations.length, 1);
  const variable = statement.declarationList.declarations[0];
  assert.ok(variable?.initializer && variable.name.getText(file) === name);
  return variable.initializer.getText(file);
}
function expanded(path: string, source: string) {
  if (path === "infrastructure/cloudflare-turn/alchemy.run.ts") return source.replace("turnStage(yield* Stage)", `${configInitializer("cloudflare-turn", "turnStage")}(yield* Stage)`);
  if (path === "infrastructure/recording-control-address/alchemy.run.ts") return source.replace("parseRelease(release.Parameter?.Value)", `${configInitializer("recording-control-address", "parseRelease")}(release.Parameter?.Value)`);
  if (path === "infrastructure/archive-cdn/alchemy.run.ts") {
    const initializer = configInitializer("archive-cdn", "publicKey");
    const match = /^Effect\.gen\(function\* \(\) \{([\s\S]*)\}\)$/.exec(initializer);
    assert.ok(match?.[1], "Public-key config shape changed; inspect before extending the proof");
    return source.replace("const encodedKey = yield* publicKey;", match[1].replace("return yield* Effect.tryPromise", "const encodedKey = yield* Effect.tryPromise"));
  }
  return source;
}
const extractedConfigs = new Set(["infrastructure/archive-cdn/config.ts", "infrastructure/recording-control-address/config.ts", "infrastructure/cloudflare-turn/config.ts"]);
function graph(entry: string, before: boolean) {
  const modules = new Map<string, { code: string; edges: string[]; declarations: string[] }>();
  function visit(path: string) {
    const identity = before ? path : originalPath(path);
    if (modules.has(identity)) return;
    const raw = before ? oldSource(path) : newSource(path);
    const file = parse(path, before ? raw : expanded(path, raw));
    const edges: string[] = [], dependencies: string[] = [], declarations: string[] = [];
    const runtime: ts.Statement[] = [];
    for (const statement of file.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        if (specifier.startsWith(".")) {
          const dependency = posix.normalize(posix.join(dirname(path), specifier));
          if (!before && extractedConfigs.has(dependency)) {
            const config = parse(dependency, newSource(dependency));
            for (const node of config.statements) if (ts.isImportDeclaration(node)) edges.push(node.getText(config));
            continue;
          }
          dependencies.push(dependency);
          edges.push(`${before ? dependency : originalPath(dependency)}:${statement.importClause?.getText(file) ?? "side-effect"}`);
        } else edges.push(statement.getText(file));
      } else runtime.push(statement);
    }
    function calls(node: ts.Node) {
      if (ts.isCallExpression(node)) {
        const id = node.arguments[0];
        if (id && ts.isStringLiteral(id) && /^(?:AWS\.|DigitalOcean\.|Cloudflare\.|SfuDroplet$|VersionedFunction$|BucketPolicy$|EipAssociation$|NetworkInterfaceSecurityGroup$|RecordingBucket$|CaptureTag$|RenderTag$|CaptureFirewall$|RenderFirewall$|R2Lifecycle$)/.test(node.expression.getText(file))) declarations.push(`${node.expression.getText(file)}:${id.text}`);
      }
      ts.forEachChild(node, calls);
    }
    calls(file);
    const code = JSON.stringify(runtime.map(ast));
    modules.set(identity, { code, edges: [...new Set(edges)].sort(), declarations: declarations.sort() });
    for (const dependency of dependencies) if (dependency.endsWith(".ts")) visit(dependency);
  }
  visit(entry);
  return [...modules.entries()].sort(([a], [b]) => a.localeCompare(b));
}
for (const stack of [...stacks.map((stack) => ({ name: stack.name, entry: `infrastructure/${entryFile(stack)}` })), { name: "r2-transcription-lifecycle", entry: "infrastructure/components/r2-transcription-lifecycle.ts" }]) {
  const entry = stack.entry;
  const before = graph(originalPath(entry), true), after = graph(entry, false);
  const differences = before.filter(([path, value]) => !isDeepStrictEqual(after.find(([name]) => name === path)?.[1], value)).map(([path]) => path);
  assert.ok(isDeepStrictEqual(after, before), `${stack.name}: changed declaration/dependencies in ${differences.join(", ")}`);
  const hash = createHash("sha256").update(JSON.stringify(before)).digest("hex");
  process.stdout.write(`${stack.name}: identical, ${before.length} transitive modules, ${hash}\n`);
}
