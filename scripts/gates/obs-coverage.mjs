#!/usr/bin/env node
// Observability coverage: every symptom in the registry must be provable end to end. For each symptom in
// observability/generated/coverage-graph.json this checks the chain of links a reader relies on:
//
//   witnesses -> facts -> events and fields -> emit sites in code -> rule -> positive and healthy fixtures -> fault scenario
//
// The fixtures must be the chain's output, not rows written by hand: each one names, in `chain`, the hand-off files under
// observability/fixtures/<code>/chain/ its rows came from, and its rows must be exactly theirs. The chain's `hops.json` declares
// each hop's test, its command and the files it writes; the first hop is the fault scenario, and every file in the chain and both
// fixtures must be written by a hop. scripts/gates/obs-chain-replay.mjs runs the hops in write mode and fails on any difference,
// which proves the files are current (observability/fixtures/end.wrong_screen/README.md).
//
// The rule is judged the one way the diagnose kernel judges it (scripts/diagnose-call/proof/rows.mjs): the positive fixture must
// give a finding with the symptom's code, and the healthy fixture must check every eligible subject and give none.
//
// A symptom with a missing link fails, unless observability/registry/coverage-allowlist.json names it; the allow-list
// is printed on every run so nobody mistakes an allow-listed symptom for a covered one. A listed symptom that is now
// complete also fails, so the list only shrinks. See observability/registry/README.md.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { checkFrom } from "../diagnose-call/proof/catalogue.mjs";
import { eventOf, judgeFixture, ruleResult } from "../diagnose-call/proof/rows.mjs";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), "utf8"));

/** Problems with one fixture row: an unknown event or field, a missing required field, or a value outside its enum. */
function rowProblems(row, index, events, fields) {
  const eventName = eventOf(row);
  const event = eventName === undefined ? undefined : events.get(eventName);
  if (!event) return [`row ${index} has unknown event ${eventName}`];
  const problems = [];
  for (const [name, value] of Object.entries(row)) {
    if (name === "event") continue;
    const field = fields.get(name);
    if (!field) {
      problems.push(`row ${index} (${eventName}) has unknown field ${name}`);
      continue;
    }
    const allowed = event.fields[name]?.values ?? field.values;
    if (field.type === "enum" && !allowed?.includes(value)) problems.push(`row ${index} (${eventName}) has ${name}=${JSON.stringify(value)}, not one of ${allowed?.join(", ")}`);
  }
  for (const [name, rule] of Object.entries(event.fields)) {
    if (rule.required && !(name in row)) problems.push(`row ${index} (${eventName}) is missing required field ${name}`);
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

/** Whether a fixture's rows are exactly the rows of the chain's hand-off files it names. */
function chainLinks(root, kind, fixture, code) {
  const dir = `observability/fixtures/${code}/chain/`;
  const chain = Array.isArray(fixture.chain) ? fixture.chain : [];
  if (chain.length === 0) return [`${kind} fixture names no chain hand-off files, so its rows are not the fault scenario's`];
  const outside = chain.filter((path) => typeof path !== "string" || !path.startsWith(dir) || !existsSync(join(root, path)));
  if (outside.length > 0) return [`${kind} fixture chain file ${outside.join(", ")} is not a hand-off file in ${dir}`];
  const rows = chain.flatMap((path) => readJson(root, path));
  return isDeepStrictEqual(rows, fixture.rows) ? [] : [`${kind} fixture rows are not the rows of its chain files ${chain.join(", ")}: run the chain with CHALK_CHAIN_WRITE=1`];
}

/** Whether the fault scenario starts the symptom's chain of declared hops. */
function faultLinks(root, symptom) {
  if (!symptom.fault_scenario) return ["a fault scenario"];
  if (!existsSync(join(root, symptom.fault_scenario))) return [`fault scenario ${symptom.fault_scenario} (file not found)`];
  return hopLinks(root, symptom);
}

/** The chain's declared hops, from `chain/hops.json`, with each written file as a path from the repository root. */
export function chainHops(root, code) {
  const dir = `observability/fixtures/${code}/chain/`;
  if (!existsSync(join(root, dir, "hops.json"))) return null;
  const { hops } = readJson(root, `${dir}hops.json`);
  if (!Array.isArray(hops)) return [];
  return hops.map((hop) => ({ ...hop, writes: (Array.isArray(hop.writes) ? hop.writes : []).map((file) => posix.normalize(`${dir}${file}`)) }));
}

/** Whether the chain's hops start at the fault scenario, can rewrite their files, and write every hand-off file and fixture. */
function hopLinks(root, symptom) {
  const dir = `observability/fixtures/${symptom.code}/chain/`;
  const hops = chainHops(root, symptom.code);
  if (hops === null) return [`chain hops ${dir}hops.json naming each hop's test, its command and the files it writes`];
  if (hops.length === 0) return [`a hop in ${dir}hops.json`];
  const missing = [];
  if (hops[0].test !== symptom.fault_scenario) missing.push(`the first hop in ${dir}hops.json must be the fault scenario ${symptom.fault_scenario}, so the chain starts from it`);
  for (const hop of hops) {
    const test = typeof hop.test === "string" ? join(root, hop.test) : null;
    if (test === null || !existsSync(test)) missing.push(`hop ${hop.hop} test ${hop.test} (file not found)`);
    else if (!readFileSync(test, "utf8").includes("CHALK_CHAIN_WRITE")) missing.push(`hop ${hop.hop} test ${hop.test} never reads CHALK_CHAIN_WRITE, so it can't rewrite what it hands off`);
    if (typeof hop.command !== "string" || hop.command === "") missing.push(`hop ${hop.hop} has no command, so the chain can't be replayed`);
  }
  const written = new Set(hops.flatMap((hop) => hop.writes));
  for (const file of written) if (!existsSync(join(root, file))) missing.push(`hop hand-off ${file} (file not found)`);
  const unwritten = readdirSync(join(root, dir)).filter((name) => name !== "hops.json" && !written.has(`${dir}${name}`));
  if (unwritten.length > 0) missing.push(`chain file ${unwritten.join(", ")} is written by no hop in ${dir}hops.json, so it may be hand-written`);
  const fixtures = Object.values(symptom.fixtures).filter((path) => !written.has(path));
  if (fixtures.length > 0) missing.push(`fixture ${fixtures.join(", ")} is written by no hop in ${dir}hops.json`);
  return missing;
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
    missing.push(...chainLinks(root, kind, fixture, symptom.code));
    if (kind === "positive") {
      for (const witness of symptom.witnesses) {
        for (const event of witness.events) {
          const eventRows = rows.filter((row) => eventOf(row) === event.event);
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
  missing.push(...faultLinks(root, symptom));
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

if (import.meta.main) {
  const { failures, allowlisted, covered } = await checkCoverage();
  console.log(`Observability coverage: ${covered.length} symptom(s) covered end to end: ${covered.join(", ") || "none"}.`);
  if (allowlisted.length > 0) {
    console.log(`${allowlisted.length} symptom(s) are allow-listed as incomplete and are NOT covered:`);
    for (const entry of allowlisted) console.log(`  ${entry.code} (slice ${entry.slice}): missing ${entry.missing.join("; ")}`);
  }
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = failures.length > 0 ? 1 : 0;
}
