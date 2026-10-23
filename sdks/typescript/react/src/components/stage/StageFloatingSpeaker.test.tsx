// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { Stage, type StageItem } from "./Stage";

type Resize = (entries: readonly { readonly contentRect: { readonly width: number; readonly height: number } }[]) => void;

// happy-dom does no layout, so the stage measures a phone through its observer.
class PhoneStage {
  readonly #resize: Resize;
  constructor(resize: Resize) {
    this.#resize = resize;
  }
  observe() {
    queueMicrotask(() => this.#resize([{ contentRect: { width: 390, height: 700 } }]));
  }
  unobserve() {}
  disconnect() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function call(speaker: "self" | "nora" | null): StageItem[] {
  const person = (id: string, isLocal = false): StageItem => ({ kind: "participant", id, participant: { id, displayName: id, isLocal, isSpeaking: speaker === id, isActiveSpeaker: speaker === id } });
  return [{ kind: "whiteboard", id: "whiteboard" }, person("self", true), person("nora"), person("malik")];
}

it("keeps the last remote speaker's face large over a phone board after the local person speaks", async () => {
  vi.stubGlobal("ResizeObserver", PhoneStage);
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (speaker: "self" | "nora" | null) => act(async () => root.render(<Stage items={call(speaker)} layout="focus" animate={false} generatedAvatars={false} />));
  try {
    for (const speaker of ["nora", "self", null] as const) await render(speaker);
    const nora = container.querySelector<HTMLElement>('[data-stage-item="nora"]');
    expect(nora?.style.width).toBe("120px");
  } finally {
    await act(async () => root.unmount());
  }
});
