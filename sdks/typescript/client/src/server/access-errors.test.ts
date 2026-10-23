import { describe, expect, it } from "vitest";
import { createChalkServerClient, isChalkAccessGrantError, type ChalkAccessGrantErrorCode } from "./index.js";
import { ChalkAPIError } from "./errors.js";

describe("access grant errors", () => {
  it.each([
    [400, "media_token.required"],
    [400, "media_token.malformed"],
    [400, "media_token.invalid_header"],
    [401, "media_token.unknown_key"],
    [401, "media_token.invalid_signature"],
    [401, "media_token.invalid_issuer"],
    [401, "media_token.invalid_audience"],
    [400, "media_token.invalid_time_claims"],
    [401, "media_token.not_yet_valid"],
    [401, "media_token.expired"],
    [400, "media_token.lifetime_exceeded"],
    [400, "media_token.invalid_subject"],
    [403, "media_token.subject_mismatch"],
    [409, "participant.generation_mismatch"],
    [403, "access.forbidden"],
  ] as const)("preserves HTTP %s %s and narrows its code", async (status, code) => {
    let calls = 0;
    const client = createChalkServerClient({
      apiKey: "server-secret",
      tenantId: "tenant-1",
      apiBaseURL: "https://api.chalk.test",
      fetch: async () => {
        calls++;
        return Response.json({ error: { code, message: "Details" } }, { status, headers: { "x-request-id": "request-1" } });
      },
    });
    const error = await client.participants.issueAccess("space-1", "episode-1", "participant-1", { participantGeneration: 1, currentMediaToken: "stored" }).catch((error: unknown) => error);
    if (!isChalkAccessGrantError(error)) throw new Error("Expected typed access grant error");
    const typedCode: ChalkAccessGrantErrorCode = error.code;
    expect(typedCode).toBe(code);
    expect(error.status).toBe(status);
    expect(error.requestId).toBe("request-1");
    expect(error.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not classify unrelated or untyped errors", () => {
    expect(isChalkAccessGrantError(new Error("access.forbidden"))).toBe(false);
    expect(isChalkAccessGrantError(new ChalkAPIError({ code: "service.unavailable", status: 503, retryable: true }))).toBe(false);
  });
});
