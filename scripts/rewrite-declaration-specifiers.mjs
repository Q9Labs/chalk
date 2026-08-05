import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

function isExtensionlessRelativeSpecifier(specifier) {
  return (specifier.startsWith("./") || specifier.startsWith("../")) && path.posix.extname(specifier) === "";
}

function staticModuleSpecifier(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return node.moduleSpecifier;
  return undefined;
}

function replacementFor(sourceFile, source, node) {
  const moduleSpecifier = staticModuleSpecifier(node);
  if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier) || !isExtensionlessRelativeSpecifier(moduleSpecifier.text)) return undefined;

  const start = moduleSpecifier.getStart(sourceFile) + 1;
  const end = moduleSpecifier.end - 1;
  return { start, end, text: `${source.slice(start, end)}.js` };
}

export function rewriteDeclarationSpecifiers(source) {
  const sourceFile = ts.createSourceFile("declaration.d.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const replacements = [];
  const visit = (node) => {
    const replacement = replacementFor(sourceFile, source, node);
    if (replacement) replacements.push(replacement);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return replacements.reduceRight((rewritten, replacement) => `${rewritten.slice(0, replacement.start)}${replacement.text}${rewritten.slice(replacement.end)}`, source);
}

function directFileForEntry(directory, entry, suffix) {
  if (!entry.isFile()) return [];
  if (!entry.name.endsWith(suffix)) return [];
  return [path.join(directory, entry.name)];
}

async function filesForEntry(directory, entry, suffix) {
  if (entry.isDirectory()) return filesWithSuffix(path.join(directory, entry.name), suffix);
  return directFileForEntry(directory, entry, suffix);
}

async function filesWithSuffix(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => filesForEntry(directory, entry, suffix)));
  return files.flat();
}

async function rewriteDeclarationFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const rewritten = rewriteDeclarationSpecifiers(source);
  if (rewritten === source) return 0;
  await writeFile(filePath, rewritten);
  return 1;
}

export async function rewriteDeclarationFiles(directory) {
  const [files, mapFiles] = await Promise.all([filesWithSuffix(directory, ".d.ts"), filesWithSuffix(directory, ".d.ts.map")]);
  const changedFiles = (await Promise.all(files.map(rewriteDeclarationFile))).reduce((total, changed) => total + changed, 0);
  await Promise.all(mapFiles.map((filePath) => unlink(filePath)));
  return { changedFiles, removedMaps: mapFiles.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  if (!directory) throw new Error("A declaration directory is required");
  const { changedFiles, removedMaps } = await rewriteDeclarationFiles(path.resolve(directory));
  process.stdout.write(`Rewrote declaration specifiers in ${changedFiles} file(s); removed ${removedMaps} declaration map file(s).\n`);
}
