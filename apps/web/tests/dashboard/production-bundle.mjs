import { readFile } from "node:fs/promises";
import { strict as assert } from "node:assert";
const bundle = await readFile(new URL("../../dist/client/_worker.js", import.meta.url), "utf8");
for (const forbidden of ["fixture_ada", "fixture_malik", "/fixture/authorize", "fixture-code-rejected", "fixtureSessionPeople"]) assert(!bundle.includes(forbidden), `Production bundle contains ${forbidden}`);
console.log("PASS: production Pages bundle has no fixture identity implementation");
const routes = JSON.parse(await readFile(new URL("../../dist/client/_routes.json", import.meta.url), "utf8"));
assert(routes.include.length > 0);
assert(
  routes.include.every((path) => /^\/(auth|dashboard-api)\//.test(path)),
  "Static site/docs must not invoke the dashboard worker",
);
for (const path of ["/auth/start", "/auth/callback", "/auth/session", "/auth/refresh", "/auth/sign-out", "/dashboard-api/home", "/dashboard-api/call", "/dashboard-api/past-session", "/dashboard-api/developer"]) {
  assert(
    routes.include.some((pattern) => (pattern.endsWith("*") ? path.startsWith(pattern.slice(0, -1)) : path === pattern)),
    `Missing worker route ${path}`,
  );
}
console.log("PASS: release-directory worker and generated route manifest include only auth/dashboard Functions");
