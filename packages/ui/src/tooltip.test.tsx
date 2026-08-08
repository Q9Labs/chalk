import type React from "react";
import { describe, expect, it } from "vitest";

import { Tooltip } from "./tooltip";

describe("Tooltip", () => {
  it("passes content-form delay to the provider and className to the popup", () => {
    const provider = Tooltip({ content: "Helpful text", children: "Help", className: "custom-popup", delay: 450 }) as React.ReactElement;
    const root = provider.props.children as React.ReactElement;
    const content = root.props.children[1] as React.ReactElement;

    expect(provider.props.delay).toBe(450);
    expect(content.props.className).toBe("custom-popup");
  });
});
