import { describe, expect, it } from "bun:test";
import { classifyTarget, decodeTokenClaimsPreview, maskSecret, resolveDevDiagnosticsMode } from "./dev-diagnostics";

describe("dev diagnostics helpers", () => {
  it("classifies local, production, and custom targets", () => {
    expect(classifyTarget("http://localhost:8080")).toBe("local");
    expect(classifyTarget("http://192.168.1.5:8080")).toBe("local");
    expect(classifyTarget("https://chalk-api.q9labs.ai")).toBe("production");
    expect(classifyTarget("https://staging.chalk.q9labs.ai")).toBe("custom");
    expect(classifyTarget("not-a-url")).toBe("unknown");
  });

  it("keeps diagnostics enabled for debug builds even when targeting production", () => {
    expect(resolveDevDiagnosticsMode({ isDevRuntime: true, apiUrl: "https://chalk-api.q9labs.ai" })).toEqual({
      enabled: true,
      buildProfile: "development",
      target: "production",
    });
  });

  it("masks long and short secrets without exposing the full value", () => {
    expect(maskSecret("ck_live_123456789")).toBe("ck_liv...6789");
    expect(maskSecret("shortkey")).toBe("sh***ey");
    expect(maskSecret(null)).toBeNull();
  });

  it("decodes jwt claims previews when the token looks like a jwt", () => {
    const preview = decodeTokenClaimsPreview("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJ0ZW5hbnRfaWQiOiJ0ZW5hbnQtMSIsInJvb21faWQiOiJyb29tLTEiLCJleHAiOjE3MDAwMDAwMDB9.c2ln");

    expect(preview?.header).toEqual({ alg: "HS256" });
    expect(preview?.payload).toEqual({
      sub: "user-1",
      tenant_id: "tenant-1",
      room_id: "room-1",
      exp: 1700000000,
    });
    expect(preview?.error).toBeNull();
  });

  it("returns null for opaque non-jwt tokens", () => {
    expect(decodeTokenClaimsPreview("join_token_opaque")).toBeNull();
  });
});
