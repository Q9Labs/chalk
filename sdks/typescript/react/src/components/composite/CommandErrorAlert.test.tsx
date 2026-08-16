// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CommandErrorAlert } from "./CommandErrorAlert";

describe("CommandErrorAlert", () => {
  it("renders the command failure as an alert", () => {
    const view = render(<CommandErrorAlert message="Microphone update failed" />);

    expect(screen.getByRole("alert")).toHaveTextContent("Microphone update failed");
    expect(view.container.querySelector("svg[data-chalk-chrome='true']")).toBeInTheDocument();
  });
});
