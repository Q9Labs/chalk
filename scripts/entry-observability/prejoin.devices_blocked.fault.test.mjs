// @ts-check
// Fault scenario for prejoin.devices_blocked on real Postgres (see specs.mjs). Run under scripts/gates/with-postgres.sh;
// CHALK_CHAIN_WRITE=1 rewrites the chain rows this scenario hands off.
import test from "node:test";
import { runScenario } from "./harness.mjs";

test("prejoin.devices_blocked fault run", () => runScenario("prejoin.devices_blocked"));
