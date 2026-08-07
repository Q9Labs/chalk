import { describe, expect, it } from "vitest";

import { ToastAction, ToastClose, ToastContent, ToastDescription, ToastRoot, ToastTitle } from "./toast";
import { renderForwardRef } from "./test-utils";

describe("Toast", () => {
  it("maps a toast record to a typed root and semantic content slots", () => {
    const root = renderForwardRef(ToastRoot, { toast: { id: "notice-1", type: "success" } });
    const content = renderForwardRef(ToastContent, { children: "Saved" });
    const title = renderForwardRef(ToastTitle, { children: "Episode saved" });
    const description = renderForwardRef(ToastDescription, { children: "The capture is ready." });

    expect(root.props["data-slot"]).toBe("toast");
    expect(root.props["data-type"]).toBe("success");
    expect(content.props["data-slot"]).toBe("toast-content");
    expect(title.props["data-slot"]).toBe("toast-title");
    expect(description.props["data-slot"]).toBe("toast-description");
  });

  it("keeps action and close controls identifiable and focusable", () => {
    const action = renderForwardRef(ToastAction, { children: "Open" });
    const close = renderForwardRef(ToastClose, { "aria-label": "Dismiss saved notice", children: "Dismiss" });

    expect(action.props["data-slot"]).toBe("toast-action");
    expect(action.props.className).toContain("chalk-ui-focusable");
    expect(close.props["data-slot"]).toBe("toast-close");
    expect(close.props["aria-label"]).toBe("Dismiss saved notice");
    expect(close.props.children).toBe("Dismiss");
  });
});
