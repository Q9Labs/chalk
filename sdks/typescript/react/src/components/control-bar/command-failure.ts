import { SpaceClientError, type ClientFailure } from "@q9labsai/chalk-client";

export function commandFailure(cause: unknown): ClientFailure {
  return cause instanceof SpaceClientError
    ? cause
    : new SpaceClientError({
        code: "client.internal_error",
        recoverable: false,
        message: cause instanceof Error ? cause.message : "This command could not be completed.",
      });
}
