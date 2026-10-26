#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../script-entry.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export function invariants(text) {
  const result = [];
  let active = true;
  let fence = false;
  let block;
  const flush = () => {
    if (block) result.push(block);
    block = undefined;
  };
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^## /.test(line)) {
      flush();
      active = !/^## (?:Tracker maintenance|Test index)$/.test(line);
      continue;
    }
    if (/^```/.test(line)) {
      flush();
      fence = !fence;
      continue;
    }
    if (!active || fence || /^#|^<!-- test:/.test(line)) continue;
    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^(?:- |\d+\. )/.test(line)) flush();
    if (!block) block = { line: index + 1, text: "" };
    block.text += `${line.trim()} `;
  }
  flush();
  return result.map(({ line, text }) => {
    const ids = [...text.matchAll(/<!-- invariant:([a-z][a-z0-9-]*) -->/g)].map((match) => match[1]);
    const normalized = text
      .replace(/<!-- invariant:[^>]+ -->/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return { line, ids, hash: createHash("sha256").update(normalized).digest("hex") };
  });
}
function checkTheory(text, baseline) {
  const errors = [];
  const mappings = new Map();
  for (const match of text.matchAll(/^<!-- test:([a-z][a-z0-9-]*) ([^#\s]+)#(.+) -->$/gm)) {
    if (mappings.has(match[1])) errors.push(`theory.md:1: duplicate mapping: ${match[1]}`);
    mappings.set(match[1], { file: match[2], name: match[3] });
  }
  const seen = new Set();
  for (const invariant of invariants(text)) {
    const fail = (message) => errors.push(`theory.md:${invariant.line}: ${message}`);
    if (invariant.ids.length !== 1) {
      fail("each product paragraph/list item needs exactly one invariant id");
      continue;
    }
    const [id] = invariant.ids;
    if (seen.has(id)) fail(`duplicate invariant id: ${id}`);
    seen.add(id);
    const mapping = mappings.get(id);
    if (!mapping) {
      if (baseline[id] !== invariant.hash) fail(`${id}: new or changed invariant needs a named test mapping`);
      continue;
    }
    const testPath = path.resolve(root, mapping.file);
    if (!testPath.startsWith(root) || !existsSync(testPath) || !/(?:_test\.(?:go|exs)|\.(?:test|spec)\.[cm]?[jt]sx?)$/.test(mapping.file)) {
      fail(`${id}: missing test file: ${mapping.file}`);
      continue;
    }
    const testSource = readFileSync(testPath, "utf8");
    const source = mapping.file.endsWith(".exs") ? testSource : testSource.replace(/("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(\/\/[^\r\n]*|\/\*[\s\S]*?\*\/)/g, (token, literal) => literal ?? token.replace(/[^\r\n]/g, " "));
    const names = [...[...source.matchAll(/^\s*func (Test\w+)\(t \*testing\.T\)/gm)].map((match) => match[1]), ...[...source.matchAll(/^\s*(?:test|it)\(\s*["'`]([^"'`]+)["'`]\s*,/gm)].map((match) => match[1]), ...[...source.matchAll(/^\s*test "([^"]+)"(?:\s*,|\s+do)/gm)].map((match) => match[1])];
    if (!names.includes(mapping.name)) fail(`${id}: named test does not exist: ${mapping.file}#${mapping.name}`);
  }
  for (const id of mappings.keys()) if (!seen.has(id)) errors.push(`theory.md:1: mapping has no invariant: ${id}`);
  for (const id of Object.keys(baseline)) if (!seen.has(id) || mappings.has(id)) errors.push(`theory.md:1: remove obsolete baseline entry: ${id}`);
  return errors;
}
if (isMain(import.meta)) {
  const text = readFileSync(path.join(root, "theory.md"), "utf8");
  const baseline = Object.fromEntries(JSON.parse(readFileSync(path.join(root, "scripts/gates/theory-baseline.json"), "utf8")).map(({ id, sha256 }) => [id, sha256]));
  const errors = checkTheory(text, baseline);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log(`theory-coverage: ${invariants(text).length} invariants; ${Object.keys(baseline).length} frozen gaps`);
}
