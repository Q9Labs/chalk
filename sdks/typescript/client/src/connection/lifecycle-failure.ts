import { Data } from "effect";
import { SFUError } from "../media/types";
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

/** The HTTP status of a refusal from Chalk's media signalling, as a failure field. A 401 or 403 is an access problem and a retryable status is recovery, so neither counts. */
export function mediaRefusalField(cause: unknown): { readonly mediaHttpStatus?: number } {
  if (!(cause instanceof SFUError)) return {};
  const { status, retryableConnection } = cause.options;
  return status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403 && !retryableConnection ? { mediaHttpStatus: status } : {};
}

/** Whether media startup timed out or failed in ICE, as a failure field. The failure detail uses it to tell a network block from a media-signalling fault. */
export function mediaIceFailureField(cause: unknown): { readonly mediaIceFailure?: true } {
  return cause instanceof SFUError && cause.code === "ice_connection_failed" ? { mediaIceFailure: true } : {};
}
