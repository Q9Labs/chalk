/* @vitest-environment jsdom */
/// <reference types="vitest/jsdom" />
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { CallDialogContent } from "./CallDialogContent";

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function inputText(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

it("keeps an unsent report draft when the dialog reopens", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const focusScope = { current: document.body };
  const dialog = (open: boolean) => <CallDialogContent kind="report" open={open} onClose={() => undefined} onReportProblem={async () => undefined} diagnostics="" focusScope={focusScope} />;
  await act(async () => root?.render(dialog(true)));
  const textarea = document.querySelector("textarea");
  expect(textarea).toBeDefined();
  await act(async () => inputText(textarea as HTMLTextAreaElement, "draft"));
  await act(async () => root?.render(dialog(false)));
  await act(async () => root?.render(dialog(true)));
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("draft");
});
