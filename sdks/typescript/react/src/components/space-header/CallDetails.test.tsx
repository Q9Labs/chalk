// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { CallDialog } from "./CallDetails";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("accepts 1,000 emoji and caps report input by Unicode code points", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const send = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<CallDialog kind="report" open onClose={() => {}} onReportProblem={send} diagnostics="" focusScope={createRef<HTMLElement>()} />));
    const textarea = document.querySelector("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) throw new Error("Report form missing");
    expect(textarea.getAttribute("maxlength")).toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "🎥".repeat(1001));
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(Array.from(textarea.value)).toHaveLength(1000);
    await act(async () => textarea.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledWith({ description: "🎥".repeat(1000), diagnostics: undefined });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("keeps rejected text editable and shows safe retry guidance", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reason = new Error("private transport detail");
  const send = vi.fn().mockRejectedValueOnce(reason);
  send.mockResolvedValueOnce(undefined);
  try {
    await act(async () => root.render(<CallDialog kind="report" open onClose={() => {}} onReportProblem={send} diagnostics="" focusScope={createRef<HTMLElement>()} />));
    const textarea = document.querySelector("textarea");
    if (!textarea) throw new Error("Report form missing");
    const enter = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const submit = async () =>
      act(async () => {
        textarea.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
    await enter("The call failed with a code");
    await submit();
    const alert = container.querySelector('[role="alert"]')?.textContent;
    expect(alert).toContain("Your report could not be sent. Try again.");
    expect(alert).not.toContain("private transport detail");
    expect(textarea.value).toBe("The call failed with a code");
    expect(textarea.disabled).toBe(false);
    await enter("The call failed");
    await submit();
    expect(send).toHaveBeenLastCalledWith({ description: "The call failed", diagnostics: undefined });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Sent");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it("starts a fresh report session on reopening without retaining the old draft", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const focusScope = createRef<HTMLElement>();
  const render = (open: boolean) => act(async () => root.render(<CallDialog kind="report" open={open} onClose={() => {}} onReportProblem={async () => {}} diagnostics="" focusScope={focusScope} />));
  try {
    await render(true);
    const textarea = document.querySelector("textarea");
    if (!textarea) throw new Error("Report form missing");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Old draft");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(textarea.value).toBe("Old draft");
    await render(false);
    await render(true);
    expect(document.querySelector("textarea")?.value).toBe("");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
