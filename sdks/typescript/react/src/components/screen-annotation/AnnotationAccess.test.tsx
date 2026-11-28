// @vitest-environment jsdom
import type { ScreenAnnotationClient, ScreenAnnotationState } from "@q9labsai/chalk-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { DrawEntry, policies, policyLabel } from "./AnnotationAccess";

afterEach(() => document.body.replaceChildren());

const me = "viewer-1";
const client = { serverNowMs: () => 1000 } as ScreenAnnotationClient;
const stateWith = (access: Partial<ScreenAnnotationState["access"]>, paused = false): ScreenAnnotationState => ({
  layer: { layer_id: "layer", publication_id: "pub", sharer_id: "sharer-1", frame: { width: 1600, height: 900 } },
  fence: 1,
  revision: 1,
  marks: [],
  paused,
  access: { draw_policy: "everyone", can_draw: true, can_manage_policy: false, can_moderate: false, default_color: "#ff734e", requests: [], ...access },
});

function render(state: ScreenAnnotationState, onRequest = () => {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<DrawEntry client={client} state={state} actorId={me} sharerName="Nora Patel" onDraw={() => {}} onRequest={onRequest} />));
  return host;
}

it("maps Ask first onto the picked policy and keeps Everyone as the default wording", () => {
  expect(policies.map(({ value, label }) => [value, label])).toEqual([
    ["everyone", "Everyone"],
    ["picked", "Ask first"],
    ["hosts", "Only hosts"],
  ]);
  expect(policyLabel("picked")).toBe("Ask first");
});

it("offers Draw when the viewer may draw", () => {
  expect(render(stateWith({})).textContent).toBe("Draw");
});

it("offers Ask to draw under Ask first, then shows the pending ask with the sharer's first name", () => {
  const asks = vi.fn();
  const host = render(stateWith({ draw_policy: "picked", can_draw: false }), asks);
  const button = host.querySelector("button");
  expect(button?.textContent).toBe("Ask to draw");
  act(() => button?.click());
  expect(asks).toHaveBeenCalledOnce();

  document.body.replaceChildren();
  const pending = render(stateWith({ draw_policy: "picked", can_draw: false, requests: [{ request_id: "r", participant_id: me, expires_at_ms: 5000 }] }));
  expect(pending.querySelector("button")).toBeNull();
  expect(pending.textContent).toContain("Asked Nora to let you draw");
});

it("shows no draw control when only hosts can draw", () => {
  expect(render(stateWith({ draw_policy: "hosts", can_draw: false })).textContent).toBe("");
});
