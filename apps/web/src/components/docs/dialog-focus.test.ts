/* @vitest-environment jsdom */

import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { trapDialogFocus } from "./dialog-focus";

afterEach(cleanup);

describe("trapDialogFocus", () => {
  it("keeps forward and reverse tab movement inside a modal", () => {
    render(createElement("section", { role: "dialog", "aria-label": "Example", onKeyDown: trapDialogFocus }, createElement("button", { type: "button" }, "First"), createElement("a", { href: "/docs" }, "Last")));

    const dialog = screen.getByRole("dialog", { name: "Example" });
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("link", { name: "Last" });

    first.focus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });
});
