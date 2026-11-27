// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { FileTypeBadge } from "./FileTypeBadge";

afterEach(() => document.body.replaceChildren());

function badge(fileName: string): HTMLElement {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<FileTypeBadge fileName={fileName} />));
  return document.body.querySelector("span") as HTMLElement;
}

it("shows the file's own type", () => {
  expect(badge("pptx-security.pptx").textContent).toBe("PPTX");
  expect(badge("grades.XLSX").textContent).toBe("XLSX");
  expect(badge("locked-pass.docx").className).toContain("--chalk-file-doc");
});

it("shows a neutral document icon when the name has no short extension", () => {
  const unnamed = badge("README");
  expect(unnamed.textContent).toBe("");
  expect(unnamed.querySelector("svg")).not.toBeNull();
});
