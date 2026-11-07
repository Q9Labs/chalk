// Condenses a TLC counterexample into one line per step: the action and the
// variables it changed. Usage: node trace-diff.mjs results/<run>.txt
import { readFileSync } from "node:fs";

const [traceFile, specArg] = process.argv.slice(2);
const text = readFileSync(traceFile, "utf8");
// The trace names its module ("of module MediaHeal"); the spec sits next to this script.
const moduleName = text.match(/of module (\w+)/)?.[1];
const specFile = specArg ?? new URL(`${moduleName ?? "MediaControl"}.tla`, import.meta.url).pathname;
const specLines = readFileSync(specFile, "utf8").split("\n");
const actionAt = (line, col, endCol) =>
  specLines[line - 1]
    .slice(col - 1, endCol)
    .replace(/^\\\/\s*/, "")
    .replace(/\s*\/\\ Stamp$/, "")
    .trim();
const states = [];
let current = null;
for (const line of text.split("\n")) {
  const header = line.match(/^State (\d+): (.*)$/);
  if (header) {
    current = { n: Number(header[1]), label: header[2].replace(/<Next line (\d+), col (\d+) to line \d+, col (\d+) of module \w+>/, (_, l, c, e) => actionAt(Number(l), Number(c), Number(e))).replace(/[<>]/g, ""), vars: new Map(), key: null };
    states.push(current);
    continue;
  }
  if (!current) continue;
  const assign = line.match(/^\/\\ (\w+) = (.*)$/);
  if (assign) {
    current.key = assign[1];
    current.vars.set(current.key, assign[2].trim());
  } else if (current.key && /^\s+\S/.test(line)) {
    current.vars.set(current.key, `${current.vars.get(current.key)} ${line.trim()}`);
  }
}
const hide = new Set(["viewHm", "cfails", "mutes", "loss", "drops"]);
for (let i = 0; i < states.length; i += 1) {
  const prev = i > 0 ? states[i - 1].vars : new Map();
  const changed = [...states[i].vars].filter(([k, v]) => !hide.has(k) && prev.get(k) !== v).map(([k, v]) => `${k}=${v.replace(/\s+/g, " ")}`);
  console.log(`${states[i].n}. ${states[i].label}: ${changed.join("; ")}`);
}
