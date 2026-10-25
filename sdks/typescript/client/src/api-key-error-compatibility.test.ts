import { expectTypeOf, it } from "vitest";
import type { CreateAPIKeyError, RotateAPIKeyError } from "./effect";

// The tags handled exhaustively by existing 5.x consumers.
type ExistingCreateErrorTag =
  | "AccessForbiddenError"
  | "AccessUnauthenticatedError"
  | "ApiKeySecretNotReplayableError"
  | "RequestIdempotencyConflictError"
  | "RequestInvalidError"
  | "RequestInvalidIdempotencyKeyError"
  | "RequestPayloadTooLargeError"
  | "RequestRateLimitedError"
  | "ServiceInternalError"
  | "ServiceUnavailableError"
  | "TenantInvalidIdError";
type ExistingRotateErrorTag = ExistingCreateErrorTag | "ApiKeyInactiveError" | "ApiKeyInvalidIdError" | "ApiKeyNotFoundError";

it("keeps exhaustive API-key error handlers source-compatible within 5.x", () => {
  expectTypeOf<CreateAPIKeyError["_tag"]>().toEqualTypeOf<ExistingCreateErrorTag>();
  expectTypeOf<RotateAPIKeyError["_tag"]>().toEqualTypeOf<ExistingRotateErrorTag>();
});
