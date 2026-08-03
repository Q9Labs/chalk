import { describe, expect, it } from "vitest";

import { Input } from "./input";

describe("Input", () => {
  it("keeps the native type and accessibility props while applying the shared slot", () => {
    const element = Input({ type: "email", "aria-label": "Email address" });

    expect(element.props.type).toBe("email");
    expect(element.props["aria-label"]).toBe("Email address");
    expect(element.props["data-slot"]).toBe("input");
    expect(element.props.className).toContain("border-input");
  });
});
