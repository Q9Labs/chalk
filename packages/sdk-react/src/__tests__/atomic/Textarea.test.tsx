import { describe, it, expect, vi } from "bun:test";
import { render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Textarea } from "../../components/atomic/Textarea";

describe("Textarea", () => {
  it("renders correctly with label", () => {
    const { getByLabelText } = render(<Textarea label="Message" placeholder="Type here" />);
    expect(getByLabelText("Message")).toBeDefined();
  });

  it("handles change events", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { getByPlaceholderText } = render(<Textarea placeholder="Type here" onChange={onChange} />);
    const textarea = getByPlaceholderText("Type here") as HTMLTextAreaElement;
    await user.type(textarea, "a");
    expect(onChange).toHaveBeenCalled();
  });

  it("shows character count when showCount is true", () => {
    const { getByText } = render(<Textarea value="abc" showCount maxLength={10} onChange={() => {}} />);
    expect(getByText("3 / 10")).toBeDefined();
  });

  it("displays error message", () => {
    const { getByText } = render(<Textarea error="Too short" />);
    expect(getByText("Too short")).toBeDefined();
  });

  it("can be disabled", () => {
    const { getByRole } = render(<Textarea disabled />);
    expect(getByRole("textbox")).toBeDisabled();
  });
});
