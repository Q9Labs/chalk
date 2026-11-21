// @ts-check
// Fault scenario for admission.unresolved on real Postgres (see specs.mjs). Run under scripts/gates/with-postgres.sh;
// CHALK_CHAIN_WRITE=1 rewrites the chain rows this scenario hands off.
import test from "node:test";
import { runScenario } from "./harness.mjs";

test("admission.unresolved fault run", () => runScenario("admission.unresolved"));
