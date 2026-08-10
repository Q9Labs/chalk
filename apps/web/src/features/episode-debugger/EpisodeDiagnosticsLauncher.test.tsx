// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { EpisodeDiagnosticsLauncher } from "./EpisodeDiagnosticsLauncher";
import { TEST_REFERENCE } from "./test-fixtures";

afterEach(cleanup);

describe("EpisodeDiagnosticsLauncher", () => {
  it("stays absent when production diagnostics are disabled", () => {
    const { container } = render(<EpisodeDiagnosticsLauncher enabled={false} />);
    expect(container.childElementCount).toBe(0);
  });

  it.each([TEST_REFERENCE, "chalk.episode:33333333-3333-4333-8333-333333333333"])("opens %s through the same-origin debugger", (reference) => {
    render(<EpisodeDiagnosticsLauncher enabled />);
    fireEvent.change(screen.getByLabelText("Diagnostic reference"), { target: { value: reference } });

    expect(screen.getByRole("link", { name: "Open Episode Debugger" }).getAttribute("href")).toContain(encodeURIComponent(reference));
  });

  it("does not link malformed input", () => {
    render(<EpisodeDiagnosticsLauncher enabled />);
    fireEvent.change(screen.getByLabelText("Diagnostic reference"), { target: { value: "not a reference" } });

    expect(screen.queryByRole("link", { name: "Open Episode Debugger" })).toBeNull();
    expect((screen.getByRole("button", { name: "Open Episode Debugger" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
