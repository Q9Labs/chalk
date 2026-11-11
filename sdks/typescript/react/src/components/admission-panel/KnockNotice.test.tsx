// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { KnockNoticeSurface, summarizeKnocks, type KnockRequest } from "./KnockNotice";

const requests = (...names: string[]): KnockRequest[] => names.map((displayName) => ({ id: `request-${displayName}`, displayName }));

it("groups two or more knocks into one summary and keeps one knock as a person", () => {
  expect(summarizeKnocks([])).toBeNull();
  expect(summarizeKnocks(requests("Rania"))).toMatchObject({ kind: "one", request: { displayName: "Rania" } });
  expect(summarizeKnocks(requests("Rania", "Omar", "Lena", "Sam"))).toMatchObject({ kind: "several", count: 4, names: "Rania, Omar, Lena, Sam" });
  expect(summarizeKnocks(requests("Rania", "Omar", "Lena", "Sam")).faces).toHaveLength(3);
});

async function mount(node: React.ReactNode) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(node));
  return { element, unmount: () => act(async () => root.unmount()) };
}
const button = (element: HTMLElement, label: string) => [...element.querySelectorAll("button")].find((candidate) => candidate.textContent === label);

it("answers one knock with Decline and Let in", async () => {
  const onAdmit = vi.fn(async () => undefined);
  const onDeny = vi.fn(async () => undefined);
  const { element, unmount } = await mount(<KnockNoticeSurface requests={requests("Rania")} onAdmit={onAdmit} onDeny={onDeny} onReview={() => undefined} onHide={() => undefined} />);
  expect(element.textContent).toContain("Rania");
  await act(async () => button(element, "Let in")?.click());
  expect(onAdmit).toHaveBeenCalledWith("request-Rania");
  await act(async () => button(element, "Decline")?.click());
  expect(onDeny).toHaveBeenCalledWith("request-Rania");
  await unmount();
});

it("shows one grouped notice for several knocks and reports a partial Let everyone in", async () => {
  const onAdmit = vi.fn(async (id: string) => {
    if (id === "request-Omar") throw new Error("expired");
  });
  const onReview = vi.fn();
  const { element, unmount } = await mount(<KnockNoticeSurface requests={requests("Rania", "Omar", "Lena")} onAdmit={onAdmit} onDeny={async () => undefined} onReview={onReview} onHide={() => undefined} />);
  expect(element.querySelectorAll('[data-part="knock-notice"]')).toHaveLength(1);
  expect(element.textContent).toContain("3 people want to join");
  await act(async () => button(element, "Review")?.click());
  expect(onReview).toHaveBeenCalledOnce();
  await act(async () => button(element, "Let everyone in")?.click());
  expect(onAdmit).toHaveBeenCalledTimes(3);
  expect(element.querySelector('[role="alert"]')?.textContent).toBe("2 of 3 let in");
  await unmount();
});
