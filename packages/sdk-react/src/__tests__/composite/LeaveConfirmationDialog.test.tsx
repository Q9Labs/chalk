import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, mock } from "bun:test";

import { LeaveConfirmationDialog } from "../../components/composite/LeaveConfirmationDialog";

describe("LeaveConfirmationDialog", () => {
  it("uses the same vivid destructive styling as the dock leave button", () => {
    const { getByRole } = render(<LeaveConfirmationDialog isOpen onClose={mock(() => {})} onConfirm={mock(() => {})} />);

    const leaveButton = getByRole("button", { name: "Leave" });

    expect(leaveButton.className).toContain("bg-[#dc2626]");
    expect(leaveButton.className).toContain("hover:bg-[#b91c1c]");
    expect(leaveButton.className).toContain("text-white");
  });
});
