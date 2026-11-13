import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

function rewriteDeclarationSpecifiers(source) {
  const sourceFile = ts.createSourceFile("declaration.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const replacements = [];
  const visit = (node) => {
    const specifier = ts.isImportDeclaration(node) || ts.isExportDeclaration(node) ? node.moduleSpecifier : undefined;
    if (specifier && ts.isStringLiteral(specifier) && /^\.\.?\//u.test(specifier.text) && path.posix.extname(specifier.text) === "") {
      replacements.push(specifier.end - 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return replacements.reduceRight((rewritten, end) => `${rewritten.slice(0, end)}.js${rewritten.slice(end)}`, source);
}

async function filesWithSuffix(directory, suffix) {
  return (await readdir(directory, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => path.join(entry.parentPath, entry.name));
}

async function rewriteDeclarationFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const rewritten = rewriteDeclarationSpecifiers(source);
  if (rewritten === source) return 0;
  await writeFile(filePath, rewritten);
  return 1;
}

async function rewriteDeclarationFiles(directory) {
  const [files, mapFiles] = await Promise.all([filesWithSuffix(directory, ".d.ts"), filesWithSuffix(directory, ".d.ts.map")]);
  const changedFiles = (await Promise.all(files.map(rewriteDeclarationFile))).reduce((total, changed) => total + changed, 0);
  await Promise.all(mapFiles.map((filePath) => unlink(filePath)));
  return { changedFiles, removedMaps: mapFiles.length };
}

if (import.meta.main) {
  const directory = process.argv[2];
  if (!directory) throw new Error("A declaration directory is required");
  const { changedFiles, removedMaps } = await rewriteDeclarationFiles(path.resolve(directory));
  process.stdout.write(`Rewrote declaration specifiers in ${changedFiles} file(s); removed ${removedMaps} declaration map file(s).\n`);
}
