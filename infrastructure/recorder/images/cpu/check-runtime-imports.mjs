import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export function checkRuntimeImports(rendererPath) {
  const renderer = realpathSync(rendererPath);
  const failures = [];
  let checked = 0;
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs") || entry.name.endsWith(".cjs")) inspect(path);
    }
  }
  function inspect(path) {
    const parent = pathToFileURL(path).href;
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function check(specifier, requireImport = false) {
      checked++;
      try {
        const target = requireImport ? createRequire(parent).resolve(specifier) : import.meta.resolve(specifier, parent);
        if (isBuiltin(target)) return;
        const file = target.startsWith("file:") ? fileURLToPath(target) : target;
        if (!existsSync(file)) throw new Error("resolved file does not exist");
        if (!statSync(file).isFile()) throw new Error("resolved import is not a file");
        const real = realpathSync(file);
        if (!real.startsWith(renderer + sep)) throw new Error("resolved file escapes deployed renderer");
      } catch (error) {
        failures.push(`${path}: ${specifier}: ${error.message}`);
      }
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        const argument = node.arguments[0];
        if (argument && ts.isStringLiteralLike(argument)) check(argument.text, node.expression.kind !== ts.SyntaxKind.ImportKeyword);
        else failures.push(`${path}: non-literal runtime import cannot be verified`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  walk(join(renderer, "dist", "node"));
  if (failures.length) throw new Error(`Unresolvable renderer imports:\n${failures.join("\n")}`);
  return checked;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("usage: check-runtime-imports.mjs <deployed-renderer>");
  console.log(`Verified ${checkRuntimeImports(process.argv[2])} deployed renderer imports`);
}
