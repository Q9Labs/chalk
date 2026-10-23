// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Stage, type StageItem } from "./Stage";

it("keeps capped shared content readable in overflow, even with a single stage slot", async () => {
  const person: StageItem = { kind: "participant", id: "person", participant: { id: "person", displayName: "Nora" } };
  const items: StageItem[] = [person, { kind: "screen-share", id: "share", participant: person.participant }, { kind: "whiteboard", id: "whiteboard" }];
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<Stage items={items} layout="grid" maxPerPage={1} generatedAvatars={false} animate={false} renderPrimaryContent={(item) => <div>{item.id} is readable</div>} />));
    const more = container.querySelector<HTMLButtonElement>("[data-stage-item='stage:more']");
    if (!more) throw new Error("Missing content overflow button");
    await act(async () => more.click());
    const dialog = container.querySelector("[role='dialog']");
    expect(dialog?.textContent).toContain("share is readable");
    expect(dialog?.textContent).toContain("whiteboard is readable");
    expect(dialog?.textContent).toContain("Nora");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
