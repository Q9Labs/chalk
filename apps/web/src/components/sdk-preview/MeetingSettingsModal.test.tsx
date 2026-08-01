// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MeetingSettingsModal } from "./MeetingSettingsModal";

afterEach(cleanup);

describe("MeetingSettingsModal", () => {
  it("renders device settings and delegates close", () => {
    const onClose = vi.fn();
    render(<MeetingSettingsModal isOpen onClose={onClose} />);

    expect(screen.getByRole("dialog", { name: "Meeting settings" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Microphone" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
