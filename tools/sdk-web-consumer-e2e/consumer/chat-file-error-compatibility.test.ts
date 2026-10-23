import type { ChalkChatFileErrorCode } from "@q9labsai/chalk-client";

// A patch release must keep exhaustive consumers of the published union valid.
export const chatFileErrorLabels: Record<ChalkChatFileErrorCode, string> = {
  "access.invalid": "Access rejected",
  unavailable: "Unavailable",
  permission_denied: "Permission denied",
  invalid_payload: "Invalid input",
  conflict: "Conflict",
  not_found: "Not found",
  expired: "Expired",
  file_transfer_failed: "Transfer failed",
};
