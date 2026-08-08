// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Select } from "./select";

const options = [
  { value: "microphone-a", label: "Microphone A" },
  { value: "microphone-b", label: "Microphone B" },
] as const;

describe("Select", () => {
  afterEach(cleanup);

  it("associates its label, lists options behind a disabled placeholder, and reports changes", () => {
    const onChange = vi.fn();
    render(<Select label="Microphone" options={options} value="microphone-a" onChange={onChange} />);

    const select = screen.getByLabelText("Microphone") as HTMLSelectElement;
    expect(select.value).toBe("microphone-a");
    expect((screen.getByText("Select…") as HTMLOptionElement).disabled).toBe(true);

    fireEvent.change(select, { target: { value: "microphone-b" } });
    expect(onChange).toHaveBeenCalledWith({ target: { value: "microphone-b" } });
  });

  it("marks the field invalid and shows the error text", () => {
    render(<Select label="Microphone" options={options} error="Pick a device" />);

    expect(screen.getByRole("combobox").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Pick a device")).toBeTruthy();
  });
});
