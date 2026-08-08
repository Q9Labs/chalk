// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toggle } from "./toggle";

afterEach(cleanup);

describe("Toggle", () => {
  it("associates a visible label with the control", () => {
    const onChange = vi.fn();
    render(<Toggle label="Microphone" enabled={false} onChange={onChange} />);

    const control = screen.getByRole("button", { name: "Microphone" });
    expect(control.getAttribute("id")).toBeTruthy();
    expect(screen.getByText("Microphone").getAttribute("for")).toBe(control.getAttribute("id"));

    fireEvent.click(screen.getByText("Microphone"));
    expect(onChange.mock.calls[0]?.[0]).toBe(true);
  });
});
