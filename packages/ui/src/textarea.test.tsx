// @vitest-environment happy-dom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Textarea } from "./textarea";

describe("Textarea", () => {
  afterEach(cleanup);

  it("associates its label and reports the character count against maxLength", () => {
    render(<Textarea label="Feedback" value="Hello" maxLength={120} showCount onChange={() => undefined} />);

    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(screen.getByText("Feedback")).toBeTruthy();
    expect(textarea.closest("label")?.htmlFor).toBe(textarea.id);
    expect(textarea.value).toBe("Hello");
    expect(textarea.maxLength).toBe(120);
    expect(screen.getByText("5 / 120")).toBeTruthy();
  });

  it("marks the field invalid and shows the error text", () => {
    render(<Textarea label="Feedback" error="Too short" value="" onChange={() => undefined} />);

    expect(screen.getByRole("textbox").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Too short")).toBeTruthy();
  });
});
