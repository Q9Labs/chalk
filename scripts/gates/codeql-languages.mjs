#!/usr/bin/env node
// Prints the CodeQL languages a pull request needs as a JSON array: `codeql-languages.mjs <base-ref>`.
// `--full` prints every language, which master pushes and the weekly run use.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const languages = ["actions", "go", "javascript-typescript", "python"];

const configFiles = new Set([".github/workflows/codeql.yml", "scripts/gates/codeql-languages.mjs"]);
const goFiles = new Set(["go.mod", "go.sum", "go.work", "go.work.sum"]);
// Every input the JavaScript extractor reads: https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/
const javascriptExtensions = new Set([".cjs", ".cts", ".ejs", ".es", ".es6", ".hbs", ".htm", ".html", ".js", ".json", ".jsx", ".mjs", ".mts", ".njk", ".raml", ".svelte", ".ts", ".tsx", ".vue", ".xhtm", ".xhtml", ".xml", ".yaml", ".yml"]);

// One file can be input to several extractors: a workflow file is both an Actions and a JavaScript input.
const languagesOf = (file) => {
  const name = path.basename(file);
  const extension = path.extname(file);
  const found = [];
  if (file.startsWith(".github/workflows/") || file.startsWith(".github/actions/") || name === "action.yml" || name === "action.yaml") found.push("actions");
  if (extension === ".go" || goFiles.has(name)) found.push("go");
  if (extension === ".py" || extension === ".pyi") found.push("python");
  if (javascriptExtensions.has(extension)) found.push("javascript-typescript");
  return found;
};

export function codeqlLanguages(files) {
  if (files.some((file) => configFiles.has(file) || file.startsWith(".github/codeql/"))) return languages;
  const changed = new Set(files.flatMap(languagesOf));
  return languages.filter((language) => changed.has(language));
}

function changedFiles(base) {
  const output = execFileSync("git", ["diff", "--name-only", "--no-renames", `${base}...HEAD`], { encoding: "utf8" });
  return output.split("\n").filter(Boolean);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [argument] = process.argv.slice(2);
  let selected = languages;
  if (argument !== "--full") {
    try {
      selected = codeqlLanguages(changedFiles(argument));
    } catch (error) {
      // Any failure analyses every language, so a broken selection cannot skip a scan.
      console.error(`::warning title=CodeQL language selection failed::${String(error.message).split("\n")[0]}`);
    }
  }
  console.log(`languages=${JSON.stringify(selected)}`);
}
