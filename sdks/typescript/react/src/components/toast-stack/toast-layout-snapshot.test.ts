// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { captureToastLayout, measureToastLayout } from "./toast-layout-snapshot";

it("reflows only inert native layout, without constructing custom resources, live regions, or focus targets", async () => {
  let constructors = 0,
    connections = 0;
  customElements.define(
    "notice-test-resource",
    class extends HTMLElement {
      constructor() {
        super();
        constructors += 1;
      }
      connectedCallback() {
        connections += 1;
      }
    },
  );
  const toast = document.createElement("div");
  toast.className = "chalk-toast";
  toast.setAttribute("role", "alert");
  toast.setAttribute("aria-live", "assertive");
  toast.append(document.createElement("notice-test-resource"));
  const input = document.createElement("input");
  input.autofocus = true;
  toast.append(input);
  const stack = document.createElement("div");
  const focused = document.createElement("button");
  document.body.append(stack, focused);
  focused.focus();
  const added: HTMLElement[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement) added.push(node);
  });
  observer.observe(stack, { childList: true });
  try {
    const snapshot = captureToastLayout(toast);
    measureToastLayout(stack, snapshot);
    await Promise.resolve();
    expect(constructors).toBe(1);
    expect(connections).toBe(0);
    expect(added).toHaveLength(1);
    expect(added[0]?.inert).toBe(true);
    expect(added[0]?.getAttribute("aria-hidden")).toBe("true");
    expect(added[0]?.querySelector("[autofocus], [aria-live], notice-test-resource")).toBeNull();
    expect(added[0]?.hasAttribute("aria-live")).toBe(false);
    expect(document.activeElement).toBe(focused);
    expect(stack.childNodes).toHaveLength(0);
  } finally {
    observer.disconnect();
    stack.remove();
    focused.remove();
  }
});
