// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MathEditor } from "./MathEditor";

const classNames = {
  root: "",
  toolbar: "",
  toolbarButton: "",
  loading: "",
  loadingContent: "",
  error: "",
  mathOverlay: "",
  mathDialog: "",
  mathHeader: "",
  mathTitle: "",
  mathCloseButton: "",
  mathBody: "",
  mathTextarea: "",
  mathError: "",
  mathActions: "",
  mathCancelButton: "",
  mathSubmitButton: "",
};

afterEach(cleanup);

describe("MathEditor", () => {
  it("submits trimmed LaTeX", async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<MathEditor initialLatex="  x^2  " isEditing={false} classNames={classNames} icons={{}} onClose={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("x^2"));
  });

  it("shows rendering failures", async () => {
    render(<MathEditor initialLatex="x" isEditing classNames={classNames} icons={{}} onClose={vi.fn()} onSubmit={async () => Promise.reject(new Error("Invalid LaTeX"))} />);

    fireEvent.click(screen.getByRole("button", { name: "Insert" }));

    expect(await screen.findByText("Invalid LaTeX")).toBeTruthy();
  });
});
