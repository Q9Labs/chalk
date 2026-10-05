import { describe, expect, it } from "vitest";
import { ConnectionLifecycleFailure } from "../connection/lifecycle";
import { V1SyncError } from "../sync/v1-error";
import { normalizeClientError } from "./errors";

describe("reconnect action errors", () => {
  it("keeps lifecycle action deadlines recoverable", () => {
    const error = normalizeClientError(new ConnectionLifecycleFailure({ code: "command_rejected", recoverable: true, message: "Action was not confirmed" }));
    expect(error).toMatchObject({ code: "command.rejected", recoverable: true });
  });

  it.each(["command_timeout", "operation_pending_timeout", "disconnected_before_delivery", "retry_exhausted"])("keeps %s recoverable", (code) => {
    expect(normalizeClientError(new V1SyncError("Action was not confirmed", code))).toMatchObject({ code: "connection.invalid_state", recoverable: true });
  });
});
