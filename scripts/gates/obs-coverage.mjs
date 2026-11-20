#!/usr/bin/env node
// Observability coverage: every symptom in the registry must be provable end to end. For each symptom in
// observability/generated/coverage-graph.json this checks the chain of links a reader relies on:
//
//   witnesses -> events and fields -> emit sites in code -> rule -> positive and healthy fixtures -> fault scenario
//
// A symptom with a missing link fails, unless observability/registry/coverage-allowlist.json names it; the allow-list
// is printed on every run so nobody mistakes an allow-listed symptom for a covered one. A listed symptom that is now
// complete also fails, so the list only shrinks. See observability/registry/README.md.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** Problems with one fixture row: an unknown event or field, a missing required field, or a value outside its enum. */
function rowProblems(row, index, events, fields) {
  const event = events.get(row.event);
  if (!event) return [`row ${index} has unknown event ${row.event}`];
  const problems = [];
  for (const [name, value] of Object.entries(row)) {
    if (name === "event") continue;
    const field = fields.get(name);
    if (!field) {
      problems.push(`row ${index} (${row.event}) has unknown field ${name}`);
      continue;
    }
    const allowed = event.fields[name]?.values ?? field.values;
    if (field.type === "enum" && !allowed?.includes(value)) problems.push(`row ${index} (${row.event}) has ${name}=${JSON.stringify(value)}, not one of ${allowed?.join(", ")}`);
  }
  for (const [name, rule] of Object.entries(event.fields)) {
    if (rule.required && !(name in row)) problems.push(`row ${index} (${row.event}) is missing required field ${name}`);
  }
  return problems;
}

/** The fixture's rows grouped by witness id, the shape a rule's evaluate() takes. */
const evidenceOf = (rows, witnesses) => Object.fromEntries(witnesses.map((witness) => [witness.id, rows.filter((row) => row.event === witness.event)]));

async function ruleLinks(root, symptom, events, fields) {
  const missing = [];
  if (!existsSync(join(root, symptom.rule))) return [`rule ${symptom.rule}`];
  const rule = await import(pathToFileURL(join(root, symptom.rule)).href);
  if (rule.symptom !== symptom.code || typeof rule.evaluate !== "function") return [`rule ${symptom.rule} must export symptom "${symptom.code}" and evaluate()`];
  for (const [kind, path] of Object.entries(symptom.fixtures)) {
    if (!existsSync(join(root, path))) {
      missing.push(`${kind} fixture ${path}`);
      continue;
    }
    const rows = readJson(root, path).rows ?? [];
    const problems = rows.flatMap((row, index) => rowProblems(row, index, events, fields));
    if (problems.length > 0) {
      missing.push(...problems.map((problem) => `${kind} fixture: ${problem}`));
      continue;
    }
    const hits = rule.evaluate(evidenceOf(rows, symptom.witnesses));
    if (kind === "positive" && hits.length === 0) missing.push(`positive fixture ${path} gives no hit`);
    if (kind === "healthy" && hits.length > 0) missing.push(`healthy fixture ${path} gives ${hits.length} hit(s)`);
    if (kind === "positive") {
      for (const witness of symptom.witnesses) {
        const witnessRows = rows.filter((row) => row.event === witness.event);
        for (const field of witness.fields) if (!witnessRows.some((row) => field in row)) missing.push(`positive fixture has no ${witness.event} row with witness field ${field}`);
      }
    }
  }
  return missing;
}

/** Every missing link for one symptom; an empty list means it is covered. */
async function symptomLinks(root, symptom, events, fields) {
  const missing = [];
  if (symptom.witnesses.length === 0) missing.push("witnesses");
  for (const event of symptom.events) {
    if (event.emit_sites.length === 0) missing.push(`an emit site for ${event.name}`);
    for (const site of event.emit_sites) {
      const path = join(root, site.path);
      if (!existsSync(path)) missing.push(`emit site ${site.path} (file not found)`);
      else if (!readFileSync(path, "utf8").includes(site.literal)) missing.push(`emit site ${site.path} no longer contains ${site.literal}`);
    }
  }
  missing.push(...(await ruleLinks(root, symptom, events, fields)));
  if (!symptom.fault_scenario) missing.push("a fault scenario");
  else if (!existsSync(join(root, symptom.fault_scenario))) missing.push(`fault scenario ${symptom.fault_scenario} (file not found)`);
  else if (!readFileSync(join(root, symptom.fault_scenario), "utf8").includes(symptom.code)) missing.push(`fault scenario ${symptom.fault_scenario} must name ${symptom.code}`);
  return missing;
}

/**
 * Checks every symptom in the coverage graph.
 * @param {{ root?: string, graph?: { symptoms: readonly any[] }, registry?: { events: readonly any[], fields: readonly any[] } }} [input]
 * @returns {Promise<{ failures: string[], allowlisted: { code: string, slice: number, missing: string[] }[], covered: string[] }>}
 */
export async function checkCoverage({ root = repositoryRoot, graph = readJson(root, "observability/generated/coverage-graph.json"), registry = readJson(root, "observability/generated/registry.json") } = {}) {
  const events = new Map(registry.events.map((event) => [event.name, event]));
  const fields = new Map(registry.fields.map((field) => [field.name, field]));
  const result = { failures: [], allowlisted: [], covered: [] };
  for (const symptom of graph.symptoms) {
    const missing = await symptomLinks(root, symptom, events, fields);
    if (symptom.allowlisted && missing.length === 0) result.failures.push(`${symptom.code} is complete: remove it from observability/registry/coverage-allowlist.json`);
    else if (symptom.allowlisted) result.allowlisted.push({ code: symptom.code, slice: symptom.slice, missing });
    else if (missing.length > 0) result.failures.push(`${symptom.code} is missing: ${missing.join("; ")}`);
    else result.covered.push(symptom.code);
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { failures, allowlisted, covered } = await checkCoverage();
  console.log(`Observability coverage: ${covered.length} symptom(s) covered end to end: ${covered.join(", ") || "none"}.`);
  if (allowlisted.length > 0) {
    console.log(`${allowlisted.length} symptom(s) are allow-listed as incomplete and are NOT covered:`);
    for (const entry of allowlisted) console.log(`  ${entry.code} (slice ${entry.slice}): missing ${entry.missing.join("; ")}`);
  }
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}
