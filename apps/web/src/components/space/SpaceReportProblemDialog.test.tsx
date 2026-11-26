/* @vitest-environment jsdom */
/// <reference types="vitest/jsdom" />
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import type { PublicSpaceAdmission } from "../../lib/chalk-access";
import { SpaceReportProblemDialog } from "./SpaceCall";

const restoreCanvas = vi.hoisted(() => {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  if (!descriptor) throw new Error("Missing canvas browser boundary");
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => ({ filter: "none" }) });
  return () => Object.defineProperty(HTMLCanvasElement.prototype, "getContext", descriptor);
});
afterAll(restoreCanvas);

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function inputText(element: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(element.constructor.prototype, "value")?.set;
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function reportSession(participantGeneration: number): PublicSpaceAdmission["session"] {
  return {
    getAccess: async () => {
      throw new Error("not used");
    },
    connectionAccess: async () => {
      throw new Error("not used");
    },
    subscribe: () => () => undefined,
    mediaProof: () => "proof",
    mediaExpiresAt: () => Date.now() + 60_000,
    reloadMarker: () => ({ episodeId: "episode", participantId: "participant", participantGeneration, mediaProof: "proof", arrivalHandle: "arrival", tenantId: "tenant" }),
    leave: async () => undefined,
  };
}

it("drops an unsent report draft when a new admission opens the dialog", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async () => Response.json({ available: true }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const focusScope = { current: document.body };
  const dialog = (generation: number, open: boolean) => (
    <SpaceReportProblemDialog tenantId="tenant" reportExpiresAt={undefined} reportSession={reportSession(generation)} diagnostics="" focusScope={focusScope} open={open} onClose={() => undefined} onReportProblem={async () => undefined} colorScheme="light" />
  );

  await act(async () => root?.render(dialog(1, true)));
  await vi.waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
  const textarea = document.querySelector("textarea");
  await act(async () => inputText(textarea as HTMLTextAreaElement, "draft"));
  await act(async () => root?.render(dialog(1, false)));
  await act(async () => root?.render(dialog(2, true)));
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("");
});

it("uses the live session expiry instead of a stale opening expiry", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async () => Response.json({ available: true }));
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const focusScope = { current: document.body };

  await act(async () => root?.render(<SpaceReportProblemDialog tenantId="tenant" reportExpiresAt={1} reportSession={reportSession(1)} diagnostics="" focusScope={focusScope} open={true} onClose={() => undefined} onReportProblem={async () => undefined} colorScheme="light" />));
  await vi.waitFor(() => expect(document.querySelector("textarea")).not.toBeNull());
  expect(document.body.textContent).not.toContain("Your call access has expired");
});
