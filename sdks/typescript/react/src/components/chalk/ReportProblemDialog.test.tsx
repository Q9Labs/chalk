// @vitest-environment happy-dom
import { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReportProblemDialog } from "./ReportProblemDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("opens the report form from a terminal screen and submits without diagnostics", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const send = vi.fn().mockResolvedValue(undefined);
  const returnFocus = createRef<HTMLButtonElement>();
  const render = (open: boolean) => act(async () => root.render(<ReportProblemDialog open={open} onClose={() => {}} onReportProblem={send} colorScheme="light" returnFocus={returnFocus} />));
  try {
    await render(false);
    expect(container.querySelector("textarea")).toBeNull();
    await render(true);
    const textarea = container.querySelector("textarea");
    expect(textarea).not.toBeNull();
    if (!textarea) throw new Error("Report form missing");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Could not connect");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledWith({ description: "Could not connect", diagnostics: undefined });
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Sent");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

it.each(["Close", "Escape", "backdrop"])("blocks %s dismissal until the pending report completes", async (dismissal) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let finish: (() => void) | undefined;
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const onClose = vi.fn();
  try {
    await act(async () => root.render(<ReportProblemDialog open onClose={onClose} onReportProblem={send} colorScheme="light" returnFocus={createRef<HTMLButtonElement>()} />));
    const textarea = container.querySelector("textarea");
    if (!textarea) throw new Error("Report form missing");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Could not connect");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(textarea.disabled).toBe(true);
    await act(async () => {
      if (dismissal === "Close") container.querySelector<HTMLButtonElement>('button[aria-label="Close"]')?.click();
      else if (dismissal === "Escape") textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      else {
        const backdrop = container.querySelector(".chalk-shell-modal-backdrop");
        if (!backdrop) throw new Error("Dialog backdrop missing");
        backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
        backdrop.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
        backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
      }
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(textarea.value).toBe("Could not connect");
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
    expect(container.querySelector('[role="status"]')?.textContent).toContain("Sent");
    await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Done")?.click());
    expect(onClose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => {
      finish?.();
      root.unmount();
    });
    container.remove();
  }
});

it.each(["Connection: failed\nLast error: media.connect_failed", undefined])("uses supplied diagnostics only when available: %s", async (diagnostics) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const send = vi.fn().mockResolvedValue(undefined);
  try {
    await act(async () => root.render(<ReportProblemDialog open onClose={() => {}} onReportProblem={send} diagnostics={diagnostics} colorScheme="light" returnFocus={createRef<HTMLButtonElement>()} />));
    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (diagnostics === undefined) {
      expect(checkbox).toBeNull();
      return;
    }
    expect(checkbox).not.toBeNull();
    await act(async () => checkbox?.click());
    const textarea = container.querySelector("textarea");
    if (!textarea) throw Error("form missing");
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "Could not connect");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => textarea.form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(send).toHaveBeenCalledWith({ description: "Could not connect", diagnostics });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
