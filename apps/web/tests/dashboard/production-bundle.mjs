import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
const bundle = await readFile(new URL("../../../../artifacts/dashboard-production.js", import.meta.url), "utf8");
for (const forbidden of ["fixture_ada", "fixture_malik", "/fixture/authorize", "fixture-code-rejected", "fixtureSessionPeople"]) assert(!bundle.includes(forbidden), `Production bundle contains ${forbidden}`);
console.log("PASS: production Pages bundle has no fixture identity implementation");
