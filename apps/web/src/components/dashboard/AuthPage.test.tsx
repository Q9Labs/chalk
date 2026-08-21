import { describe, expect, it } from "vitest";
import { dashboardSource } from "./__tests__/source";

describe("Account entry contract", () => {
  it("supports both email modes and the same-origin Google path", () => {
    const source = dashboardSource("AuthPage.tsx");
    expect(source).toContain('mode: "sign-in" | "sign-up"');
    expect(source).toContain('href="/api/auth/google/start?return_to=/home"');
    expect(source).toContain('import { Logo } from "@q9labsai/chalk-react";');
    expect(source).toContain('motion="orbit-burst"');
    expect(source).toContain('variant="wordmark"');
  });
});
