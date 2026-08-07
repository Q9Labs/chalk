// @vitest-environment happy-dom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiagnosticTable } from "./DiagnosticTable";

describe("DiagnosticTable", () => {
  it("exposes its caption and column headers to assistive technology", () => {
    render(
      <DiagnosticTable caption="Operation evidence" headers={["Operation", "State"]}>
        <tr>
          <td>screen.start</td>
          <td>running</td>
        </tr>
      </DiagnosticTable>,
    );

    expect(screen.getByRole("table", { name: "Operation evidence" })).toBeTruthy();
    expect(screen.getAllByRole("columnheader").map((header) => header.textContent)).toEqual(["Operation", "State"]);
    expect(screen.getByRole("cell", { name: "screen.start" })).toBeTruthy();
  });
});
