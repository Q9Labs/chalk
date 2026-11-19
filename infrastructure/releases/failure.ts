import { DestroyError } from "alchemy/Apply";
import type * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { chmodSync, writeFileSync } from "node:fs";
import { Refusal } from "../platform/refusal.ts";

// The engine wraps a failed delete in a DestroyError that keeps each resource's cause.
export const refusalMessages = (cause: Cause.Cause<unknown>): string[] =>
  cause.reasons.flatMap((reason) => {
    if (!Cause.isFailReason(reason)) return [];
    if (reason.error instanceof Refusal) return [reason.error.message];
    return reason.error instanceof DestroyError ? reason.error.failures.flatMap((failure) => refusalMessages(failure.cause)) : [];
  });

export function reportFailure(result: Exit.Exit<unknown, unknown>, operation: string) {
  if (result._tag !== "Failure") return;
  const file = process.env.CHALK_ALCHEMY_DIAGNOSTICS;
  if (file) {
    writeFileSync(file, Cause.pretty(result.cause), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const refusals = refusalMessages(result.cause);
  if (refusals.length) process.stderr.write(`Infrastructure ${operation} refused: ${refusals.join("; ")}\n`);
  else process.stderr.write(`Infrastructure ${operation} failed; no payload logged. Set CHALK_ALCHEMY_DIAGNOSTICS for private diagnostics.\n`);
  process.exitCode = 1;
}
