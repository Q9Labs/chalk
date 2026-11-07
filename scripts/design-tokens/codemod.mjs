#!/usr/bin/env node
// Replaces raw spacing, font-size and radius values with the design-token scale in scale.json.
// Usage: node scripts/design-tokens/codemod.mjs [--write] [--report <file>] <file...>
// Without --write it only prints what it would change. Colors and shadows are not handled here:
// they need a decision per value. Values with no step and no snap (fluid vw/em, odd one-offs) stay put.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";

const scale = JSON.parse(readFileSync(new URL("./scale.json", import.meta.url), "utf8"));

const CSS_SPACING = /^(?:(?:padding|margin)(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?|(?:row-|column-|grid-)?gap)$/;
const CSS_RADIUS = /^border(?:-(?:top|bottom|start|end)-(?:left|right|start|end))?-radius$/;
const SCRIPT_SPACING = /^(?:(?:padding|margin)(?:Top|Right|Bottom|Left|Horizontal|Vertical|(?:Inline|Block)(?:Start|End)?|Start|End)?|gap|rowGap|columnGap)$/;
const SCRIPT_RADIUS = /^border(?:(?:Top|Bottom)(?:Left|Right|Start|End)|Start(?:Start|End)|End(?:Start|End))?Radius$/;

const LENGTH = /(?<![\w.#-])-?(?:\d*\.)?\d+(?:px|rem)(?![\w%])/giu;
const CSS_DECLARATION = /(?<![\w-])([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/giu;
const SCRIPT_ENTRY = /\b([A-Za-z]+)(\s*:\s*)(?:"([^"\n]*)"|'([^'\n]*)'|(-?(?:\d+(?:\.\d+)?|\.\d+))\b)/gu;
const TAILWIND = /(?<![\w-])(-?)(p[xytrblse]?|m[xytrblse]?|gap(?:-[xy])?|space-[xy]|rounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?|text)-\[(-?[\d.]+)(px|rem)\]/gu;

const kindOfCss = (p) => (CSS_SPACING.test(p) ? "space" : CSS_RADIUS.test(p) ? "corner" : p === "font-size" ? "type" : undefined);
const kindOfScript = (k) => (SCRIPT_SPACING.test(k) ? "space" : SCRIPT_RADIUS.test(k) ? "corner" : k === "fontSize" ? "type" : undefined);

/** The step name for a magnitude in px, and whether it was snapped. */
function stepFor(kind, px) {
  const { steps, snaps } = scale[kind];
  const exact = Object.entries(steps).find(([, value]) => value === px);
  if (exact) return { name: exact[0], snapped: false };
  const snapped = snaps[String(px)];
  return snapped ? { name: snapped, snapped: true } : undefined;
}

const cssVar = (kind, name) => `var(--${kind}-${name})`;
const tsName = { space: "space", type: "fontSizes", corner: "corners" };
const tsAccess = (kind, name) => (/^[a-z]+$/u.test(name) ? `${tsName[kind]}.${name}` : `${tsName[kind]}[${/^\d+$/u.test(name) ? name : JSON.stringify(name)}]`);

/** Spaces out the var()/env()/url() groups so the length scan skips them. */
function protectedCopy(value) {
  const chars = value.split("");
  for (const match of value.matchAll(/\b(?:var|env|url)\(/gu)) {
    let depth = 0;
    for (let i = match.index + match[0].length - 1; i < value.length; i += 1) {
      depth += value[i] === "(" ? 1 : value[i] === ")" ? -1 : 0;
      if (depth === 0) {
        chars.fill(" ", match.index, i + 1);
        break;
      }
    }
  }
  return chars.join("");
}

/** Rewrites the lengths of one CSS value. `render(kind, name, negative)` makes the replacement text. */
function rewriteLengths(kind, value, render, onChange) {
  const scan = protectedCopy(value);
  let out = "";
  let last = 0;
  for (const match of scan.matchAll(LENGTH)) {
    const literal = match[0].toLowerCase();
    const number = Number.parseFloat(literal);
    const px = Math.abs(literal.endsWith("rem") ? number * 16 : number);
    if (px === 0 || (kind === "space" && px === 1 && !literal.startsWith("-"))) continue;
    const step = stepFor(kind, px);
    if (!step) continue;
    out += value.slice(last, match.index) + render(kind, step.name, number < 0);
    last = match.index + match[0].length;
    onChange({ kind, from: literal, name: step.name, snapped: step.snapped, offset: match.index });
  }
  return out + value.slice(last);
}

const cssRender = (kind, name, negative) => (negative ? `calc(${cssVar(kind, name)} * -1)` : cssVar(kind, name));
const tsRender = (kind, name, negative) => (negative ? `-${tsAccess(kind, name)}` : tsAccess(kind, name));

function transform(file, text, isNative) {
  const changes = [];
  const lineOf = (index) => text.slice(0, index).split("\n").length;
  const edits = [];
  const note = (base) => (change) => changes.push({ ...change, file, line: lineOf(base + change.offset) });

  for (const match of text.matchAll(CSS_DECLARATION)) {
    const kind = kindOfCss(match[1].toLowerCase());
    if (!kind) continue;
    const valueStart = match.index + match[0].length - match[2].length;
    const next = rewriteLengths(kind, match[2], cssRender, note(valueStart));
    if (next !== match[2]) edits.push({ start: valueStart, end: valueStart + match[2].length, text: next });
  }

  for (const match of text.matchAll(SCRIPT_ENTRY)) {
    const key = match[1];
    const kind = kindOfScript(key);
    if (!kind) continue;
    const literalStart = match.index + match[1].length + match[2].length;
    const stringBody = match[3] ?? match[4];
    if (stringBody !== undefined) {
      if (isNative) continue;
      const bodyStart = literalStart + 1;
      const next = rewriteLengths(kind, stringBody, cssRender, note(bodyStart));
      if (next !== stringBody) edits.push({ start: bodyStart, end: bodyStart + stringBody.length, text: next });
      continue;
    }
    const number = Number.parseFloat(match[5]);
    const px = Math.abs(number);
    const step = px === 0 ? undefined : stepFor(kind, px);
    if (!step || (kind === "space" && px === 1)) continue;
    changes.push({ file, line: lineOf(literalStart), kind, from: match[5], name: step.name, snapped: step.snapped });
    const replacement = isNative ? tsRender(kind, step.name, number < 0) : JSON.stringify(cssRender(kind, step.name, number < 0));
    edits.push({ start: literalStart, end: literalStart + match[5].length, text: replacement });
  }

  for (const match of text.matchAll(TAILWIND)) {
    const [whole, minus, utility, raw, unit] = match;
    const kind = utility === "text" ? "type" : utility.startsWith("rounded") ? "corner" : "space";
    const px = Math.abs(unit === "rem" ? Number.parseFloat(raw) * 16 : Number.parseFloat(raw));
    const step = px === 0 ? undefined : stepFor(kind, px);
    if (!step) continue;
    const arbitrary = Number.parseFloat(raw) < 0 ? "-" : "";
    const variable = `--${kind}-${step.name}`;
    const inner = kind === "type" ? `length:${variable}` : variable;
    changes.push({ file, line: lineOf(match.index), kind, from: `${raw}${unit}`, name: step.name, snapped: step.snapped });
    edits.push({ start: match.index, end: match.index + whole.length, text: `${minus || arbitrary}${utility}-(${inner})` });
  }

  edits.sort((a, b) => b.start - a.start);
  let next = text;
  for (const edit of edits) next = next.slice(0, edit.start) + edit.text + next.slice(edit.end);
  return { next, changes };
}

/** Adds the scale names the file now uses to its import from the theme tokens. */
function ensureImports(file, text, changes) {
  const used = [...new Set(changes.map((c) => tsName[c.kind]))].filter((name) => new RegExp(`\\b${name}[.\\[]`, "u").test(text));
  if (used.length === 0) return text;
  const inSdk = file.startsWith("sdks/typescript/react-native/src/");
  const specifier = inSdk ? relative(dirname(file), "sdks/typescript/react-native/src/theme/tokens").replaceAll("\\", "/") : "@q9labsai/chalk-react-native";
  const from = specifier;
  const existing = new RegExp(`import \\{([^}]*)\\} from "${from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}";`, "u").exec(text);
  if (existing) {
    const names = new Set(
      existing[1]
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );
    for (const name of used) names.add(name);
    return text.replace(existing[0], `import { ${[...names].join(", ")} } from "${from}";`);
  }
  const imports = [...text.matchAll(/^import [^;]*;$/gmu)];
  const line = `import { ${used.join(", ")} } from "${from.startsWith(".") && !from.startsWith("..") ? `./${from}` : from}";\n`;
  if (imports.length === 0) return line + text;
  const lastImport = imports.at(-1);
  const end = lastImport.index + lastImport[0].length + 1;
  return text.slice(0, end) + line + text.slice(end);
}

const args = process.argv.slice(2);
const write = args.includes("--write");
const reportIndex = args.indexOf("--report");
const reportPath = reportIndex === -1 ? undefined : args[reportIndex + 1];
const files = args.filter((arg, i) => !arg.startsWith("--") && args[i - 1] !== "--report");
const all = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const isNative = file.startsWith("sdks/typescript/react-native/") || file.startsWith("apps/mobile/");
  const { next, changes } = transform(file, text, isNative);
  if (changes.length === 0) continue;
  const final = isNative ? ensureImports(file, next, changes) : next;
  all.push(...changes);
  if (write) writeFileSync(file, final);
}
const snapped = all.filter((change) => change.snapped);
const lines = [`replaced ${all.length} values in ${new Set(all.map((c) => c.file)).size} files; ${snapped.length} snapped`];
for (const change of snapped) lines.push(`snap ${change.file}:${change.line} ${change.kind} ${change.from} -> ${change.name}`);
const text = lines.join("\n");
if (reportPath) writeFileSync(reportPath, `${text}\n`);
console.log(reportPath ? lines[0] : text);
