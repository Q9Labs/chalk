import assert from "node:assert/strict";
import { test } from "node:test";
import { buildModel, generate, loadRegistry } from "./obs-registry.mjs";

const source = await loadRegistry();
const clone = () => structuredClone(source);
const area = (registry, name) => registry.areas.find((entry) => entry.area === name);
const errorsOf = (registry) => buildModel(registry).errors.join("\n");

test("the committed registry builds without errors and generates every output", async () => {
  assert.deepEqual(buildModel(source).errors, []);
  const { errors, outputs } = await generate();
  assert.deepEqual(errors, []);
  for (const path of ["observability/generated/registry.json", "sdks/typescript/client/src/obs/registry.ts", "apps/sync/lib/chalk_sync/obs/registry.ex", "apps/api/internal/obs/registry_gen.go", "features/media/sfu/internal/obs/kernel.go"]) {
    assert.ok(path in outputs, `${path} is not generated`);
  }
});

test("schema_ver changes when the registry changes", () => {
  const changed = clone();
  area(changed, "selftest").fields[0].doc += " Changed.";
  assert.notEqual(buildModel(changed).model.schema_ver, buildModel(source).model.schema_ver);
});

test("fields reject banned unit suffixes, a missing sensitivity slot, duplicates and enums without values", () => {
  const broken = clone();
  const fields = area(broken, "selftest").fields;
  fields.push({ name: "wait_sec", type: "int", sensitivity: null, doc: "Seconds." });
  fields.push({ name: "loose", type: "string", doc: "No sensitivity slot." });
  fields.push({ ...fields[0] });
  fields.push({ name: "shade", type: "enum", sensitivity: null, doc: "No values." });
  fields.push({ name: "owner_ref", type: "id", id_kind: "nothing", sensitivity: null, doc: "Unknown id kind." });
  const errors = errorsOf(broken);
  assert.match(errors, /wait_sec uses a banned unit suffix/u);
  assert.match(errors, /loose needs a sensitivity slot/u);
  assert.match(errors, /is already declared by areas\/selftest/u);
  assert.match(errors, /enum field shade needs values/u);
  assert.match(errors, /owner_ref has unknown id_kind "nothing"/u);
});

test("events, reasons and machines are checked against the core lists and their area's prefixes", () => {
  const broken = clone();
  const selftest = area(broken, "selftest");
  selftest.events.push({ name: "selftest.moved", kind: "transition", dataset: "nowhere", side: "edge", modules: ["mars"], fields: { mystery: { required: true } } });
  selftest.events.push({ name: "selftest.chose", kind: "decision", dataset: source.core.datasets[0].name, side: "any", fields: {} });
  selftest.reasons.push({ code: "other.reason", outcome: "fine" });
  selftest.machines.push({
    name: "selftest.loop",
    states: ["a", "b"],
    initial: "c",
    edges: [
      ["a", "a"],
      ["a", "z"],
    ],
    triggers: [],
  });
  const errors = errorsOf(broken);
  assert.match(errors, /a transition is declared as a machine/u);
  assert.match(errors, /dataset must be one of/u);
  assert.match(errors, /side must be client, server or any/u);
  assert.match(errors, /unknown module mars/u);
  assert.match(errors, /field mystery is not declared/u);
  assert.match(errors, /a decision event needs a non-empty decisions list/u);
  assert.match(errors, /reason other\.reason must start with one of this area's prefixes/u);
  assert.match(errors, /outcome must be expected or error/u);
  assert.match(errors, /initial state "c" is not a state/u);
  assert.match(errors, /is a self-loop/u);
  assert.match(errors, /must join two declared states/u);
  assert.match(errors, /triggers must be a non-empty list/u);
});

test("a symptom's witnesses must name known facts, a fact known events, and the allow-list only known symptoms", () => {
  const broken = clone();
  const selftest = area(broken, "selftest");
  selftest.prefixes.push("ghost");
  selftest.facts = [{ name: "ghost.state", kind: "state", per: "seat", doc: "A ghost fact.", events: [{ event: "selftest.nope", source: "client", claim: "state", failure_claims: [], fields: [] }] }];
  selftest.symptoms = [{ code: "ghost.seen", item: "episode", per: "seat", doc: "A ghost.", witnesses: [{ fact: "ghost.missing", from: ["client"], required: true, query: "q", doc: "d" }] }];
  broken.core.fault_components.components.push("ghost");
  broken.allowlist.incomplete.push({ code: "ghost.unlisted", slice: 0 });
  const errors = errorsOf(broken);
  assert.match(errors, /witness names unknown fact ghost\.missing/u);
  assert.match(errors, /fact ghost\.state names unknown event selftest\.nope/u);
  assert.match(errors, /ghost is also a symptom prefix/u);
  assert.match(errors, /ghost\.unlisted is not a catalogued symptom/u);
});

test("a dataset over its field budget fails", () => {
  const broken = clone();
  for (const dataset of broken.core.datasets) dataset.budget = 1;
  assert.match(errorsOf(broken), /over its budget of 1/u);
});
