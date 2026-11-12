import { chatUploadFailureOf } from "../chat-files/types";
import type { ConnectionLifecycleCapability } from "../connection/lifecycle";

/** Sends the cause of a failed chat upload to the API's connection-report log, so a CORS block shows up on the server and not only in the user's browser. */
export function reportUploadFailure(connection: Pick<ConnectionLifecycleCapability, "recordTransportDiagnostic">, cause: unknown): void {
  const failure = chatUploadFailureOf(cause);
  if (!failure) return;
  const { httpStatus } = failure;
  connection.recordTransportDiagnostic({
    event: "chat_upload_failed",
    upload_failure: failure.kind,
    ...(httpStatus !== undefined && httpStatus >= 400 && httpStatus <= 599 ? { http_status: httpStatus } : {}),
  });
}
