import { describe, expect, it } from "bun:test";
import { classifyTarget, maskSecret } from "./dev-diagnostics";

describe("dev diagnostics helpers", () => {
  it("classifies local, production, and custom targets", () => {
    expect(classifyTarget("http://localhost:8080")).toBe("local");
    expect(classifyTarget("http://192.168.1.5:8080")).toBe("local");
    expect(classifyTarget("https://chalk-api.q9labs.ai")).toBe("production");
    expect(classifyTarget("https://staging.chalk.q9labs.ai")).toBe("custom");
    expect(classifyTarget("not-a-url")).toBe("unknown");
  });

  it("masks long and short secrets without exposing the full value", () => {
    expect(maskSecret("ck_live_123456789")).toBe("ck_liv...6789");
    expect(maskSecret("shortkey")).toBe("sh***ey");
    expect(maskSecret(null)).toBeNull();
  });
});
