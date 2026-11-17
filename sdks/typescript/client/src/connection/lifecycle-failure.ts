import { Data } from "effect";
import type { ConnectionFailure } from "./types";

export type LifecycleFailureCode = ConnectionFailure["code"];
export class ConnectionLifecycleFailure extends Data.TaggedError("ConnectionLifecycleFailure")<{
  readonly code: LifecycleFailureCode;
  readonly recoverable: boolean;
  readonly message: string;
  readonly cause?: unknown;
  readonly sync?: import("../sync/connect-diagnostics").SyncConnectDiagnostic;
}> {}

export function lifecycleFailure(code: LifecycleFailureCode, recoverable: boolean, message: string, cause?: unknown): ConnectionLifecycleFailure {
  return new ConnectionLifecycleFailure({ code, recoverable, message, ...(cause === undefined ? {} : { cause }) });
}
