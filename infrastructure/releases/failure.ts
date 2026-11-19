import type * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { chmodSync, writeFileSync } from "node:fs";

export function reportFailure(result: Exit.Exit<unknown, unknown>, operation: string) {
  if (result._tag !== "Failure") return;
  const file = process.env.CHALK_ALCHEMY_DIAGNOSTICS;
  if (file) { writeFileSync(file, Cause.pretty(result.cause), { mode: 0o600 }); chmodSync(file, 0o600); }
  process.stderr.write(`Infrastructure ${operation} failed; no payload logged. Set CHALK_ALCHEMY_DIAGNOSTICS for private diagnostics.\n`);
  process.exitCode = 1;
}
