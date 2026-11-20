#!/usr/bin/env node
// Observability coverage: every symptom in the registry must be provable end to end. For each symptom in
// observability/generated/coverage-graph.json this checks the chain of links a reader relies on:
//
//   witnesses -> facts -> events and fields -> emit sites in code -> rule -> positive and healthy fixtures -> fault scenario
//
// The rule is judged the one way the diagnose kernel judges it (scripts/diagnose-call/proof/rows.mjs): the positive fixture must
// give a finding with the symptom's code, and the healthy fixture must check every eligible subject and give none.
//
// A symptom with a missing link fails, unless observability/registry/coverage-allowlist.json names it; the allow-list
// is printed on every run so nobody mistakes an allow-listed symptom for a covered one. A listed symptom that is now
// complete also fails, so the list only shrinks. See observability/registry/README.md.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkFrom } from "../diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../diagnose-call/proof/rows.mjs";

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

/** Judges one fixture with the symptom's rule, and names the link that fails. */
function fixtureLinks(kind, path, fixture, check, code) {
  let judged;
  try {
    judged = judgeFixture(fixture, [check], code);
  } catch (error) {
    return [`${kind} fixture ${path} can't be judged: ${error.message}`];
  }
  const { findings, checked, eligible } = ruleResult(judged.verdict, code);
  const dropped = judged.dropped.map((row) => `${kind} fixture row ${row.index} (${row.event}) is dropped: ${row.why}`);
  if (kind === "positive" && findings === 0) return [...dropped, `positive fixture ${path} gives no ${code} finding`];
  if (kind === "healthy" && findings > 0) return [...dropped, `healthy fixture ${path} gives ${findings} ${code} finding(s)`];
  if (kind === "healthy" && (eligible === 0 || checked < eligible)) return [...dropped, `healthy fixture ${path} checks ${checked} of ${eligible} subject(s), so it proves nothing healthy`];
  return dropped;
}

async function ruleLinks(root, symptom, events, fields, declared) {
  const missing = [];
  if (!existsSync(join(root, symptom.rule))) return [`rule ${symptom.rule}`];
  let check;
  try {
    if (!declared) return [`a registry entry for ${symptom.code} (run pnpm run regen)`];
    check = checkFrom(declared, await import(pathToFileURL(join(root, symptom.rule)).href));
  } catch (error) {
    return [`rule ${error.message}`];
  }
  for (const [kind, path] of Object.entries(symptom.fixtures)) {
    if (!existsSync(join(root, path))) {
      missing.push(`${kind} fixture ${path}`);
      continue;
    }
    const fixture = readJson(root, path);
    const rows = fixture.rows ?? [];
    const problems = rows.flatMap((row, index) => rowProblems(row, index, events, fields));
    if (problems.length > 0) {
      missing.push(...problems.map((problem) => `${kind} fixture: ${problem}`));
      continue;
    }
    missing.push(...fixtureLinks(kind, path, fixture, check, symptom.code));
    if (kind === "positive") {
      for (const witness of symptom.witnesses) {
        for (const event of witness.events) {
          const eventRows = rows.filter((row) => row.event === event.event);
          if (eventRows.length === 0) missing.push(`positive fixture has no ${event.event} row for ${witness.fact}`);
          for (const field of event.fields) if (eventRows.length > 0 && !eventRows.some((row) => field in row)) missing.push(`positive fixture has no ${event.event} row with ${witness.fact} field ${field}`);
        }
      }
    }
  }
  return missing;
}

/** Every missing link for one symptom; an empty list means it is covered. */
async function symptomLinks(root, symptom, events, fields, declared) {
  const missing = [];
  if (symptom.witnesses.length === 0) missing.push("witnesses");
  for (const witness of symptom.witnesses) if (witness.events.length === 0) missing.push(`an event for fact ${witness.fact}`);
  for (const event of symptom.events) {
    if (event.emit_sites.length === 0) missing.push(`an emit site for ${event.name}`);
    for (const site of event.emit_sites) {
      const path = join(root, site.path);
      if (!existsSync(path)) missing.push(`emit site ${site.path} (file not found)`);
      else if (!readFileSync(path, "utf8").includes(site.literal)) missing.push(`emit site ${site.path} no longer contains ${site.literal}`);
    }
  }
  missing.push(...(await ruleLinks(root, symptom, events, fields, declared)));
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
  const declared = new Map(registry.symptoms.map((symptom) => [symptom.code, symptom]));
  const result = { failures: [], allowlisted: [], covered: [] };
  for (const symptom of graph.symptoms) {
    const missing = await symptomLinks(root, symptom, events, fields, declared.get(symptom.code));
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
