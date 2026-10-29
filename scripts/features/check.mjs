import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const featureRoot = "features/whiteboard";
const manifest = JSON.parse(readFileSync(path.join(root, featureRoot, "feature.json"), "utf8"));
const inside = (file, prefix) => file === prefix || file.startsWith(`${prefix}/`);
const allowed = (file, language) => inside(file, featureRoot) || manifest.dependencies[language].some((prefix) => inside(file, prefix));
const failures = [];
const check = (source, dependency, language) => {
  if (!allowed(dependency, language)) failures.push(`${language}: ${source} imports undeclared ${dependency}`);
};
const language = process.argv[2];
if (language === "go") {
  const modulePrefix = "github.com/q9labs/chalk/";
  const format = '{{.ImportPath}} {{join .Imports " "}} {{join .TestImports " "}} {{join .XTestImports " "}}';
  const graph = execFileSync("go", ["list", "-f", format, `./${featureRoot}/api/...`], { cwd: root, encoding: "utf8" });
  for (const line of graph.trim().split("\n")) {
    const [source, ...imports] = line.trim().split(/\s+/);
    for (const dependency of imports) if (dependency.startsWith(modulePrefix)) check(source, dependency.slice(modulePrefix.length), "go");
  }
} else if (language === "elixir") {
  const sync = path.join(root, "apps/sync");
  const output = execFileSync("mix", ["xref", "graph", "--format", "json", "--output", "-", "--no-compile"], { cwd: sync, encoding: "utf8", env: { ...process.env, MIX_ENV: "test" } });
  const graph = JSON.parse(output);
  let checked = 0;
  for (const [source, dependencies] of Object.entries(graph)) {
    const sourcePath = path.relative(root, path.resolve(sync, source));
    if (!inside(sourcePath, `${featureRoot}/sync`)) continue;
    checked++;
    for (const dependency of Object.keys(dependencies)) check(sourcePath, path.relative(root, path.resolve(sync, dependency)), "elixir");
  }
  if (checked === 0) throw new Error("No whiteboard modules in Mix xref graph. Compile the feature before checking it.");
} else {
  throw new Error("Usage: node scripts/features/check.mjs go|elixir");
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`whiteboard ${language} dependency manifest passed`);
}
