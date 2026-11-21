// @ts-check
// Fault scenario for prejoin.preview_failed on real Postgres (see specs.mjs). Run under scripts/gates/with-postgres.sh;
// CHALK_CHAIN_WRITE=1 rewrites the chain rows this scenario hands off.
import test from "node:test";
import { runScenario } from "./harness.mjs";

test("prejoin.preview_failed fault run", () => runScenario("prejoin.preview_failed"));
