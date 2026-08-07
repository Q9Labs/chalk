import { describe, expect, it } from "vitest";

import { StatusBadge } from "./status-badge";
import { renderForwardRef } from "./test-utils";

describe("StatusBadge", () => {
  it("falls back to its status when no content is supplied", () => {
    const element = renderForwardRef(StatusBadge, { status: "warning" });

    expect(element.props["data-slot"]).toBe("status-badge");
    expect(element.props["data-status"]).toBe("warning");
    expect(element.props.children).toBe("warning");
  });

  it("prioritizes an accessible label over children and keeps custom classes", () => {
    const element = renderForwardRef(StatusBadge, { children: "retrying", className: "compact", label: "Retrying", status: "info" });

    expect(element.props["data-status"]).toBe("info");
    expect(element.props.children).toBe("Retrying");
    expect(element.props.className).toContain("compact");
  });
});
