// @ts-check
// Fault scenario for boot.never_ran on real Postgres (see specs.mjs). Run under scripts/gates/with-postgres.sh;
// CHALK_CHAIN_WRITE=1 rewrites the chain rows this scenario hands off.
import test from "node:test";
import { runScenario } from "./harness.mjs";

test("boot.never_ran fault run", () => runScenario("boot.never_ran"));
