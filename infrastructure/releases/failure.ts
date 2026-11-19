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

// Error classes and tags are names our code or the provider library defines. Messages and payloads can carry
// identifiers, so they never reach stderr; a name that is not a plain identifier is reported as unclassified.
const plainName = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const nameOf = (value: unknown): string => {
  if (typeof value !== "object" || value === null) return "unclassified";
  const name = "_tag" in value && typeof value._tag === "string" ? value._tag : value.constructor?.name;
  return name !== undefined && plainName.test(name) ? name : "unclassified";
};
export const failureReasons = (cause: Cause.Cause<unknown>): string[] => {
  const reasons = cause.reasons.map((reason) => (Cause.isFailReason(reason) ? `error ${nameOf(reason.error)}` : Cause.isDieReason(reason) ? `defect ${nameOf(reason.defect)}` : "interrupted"));
  return [...new Set(reasons)].slice(0, 3);
};

export function reportFailure(result: Exit.Exit<unknown, unknown>, operation: string) {
  if (result._tag !== "Failure") return;
  const file = process.env.CHALK_ALCHEMY_DIAGNOSTICS;
  if (file) {
    writeFileSync(file, Cause.pretty(result.cause), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const refusals = refusalMessages(result.cause);
  if (refusals.length) process.stderr.write(`Infrastructure ${operation} refused: ${refusals.join("; ")}\n`);
  else process.stderr.write(`Infrastructure ${operation} failed (${failureReasons(result.cause).join("; ")}); no payload logged. Set CHALK_ALCHEMY_DIAGNOSTICS for private diagnostics.\n`);
  process.exitCode = 1;
}
