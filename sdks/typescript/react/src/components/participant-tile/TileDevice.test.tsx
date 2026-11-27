// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ParticipantTile } from "./ParticipantTile";

afterEach(() => document.body.replaceChildren());

function renderTile(participant: Parameters<typeof ParticipantTile>[0]["participant"]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined }));
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(<ParticipantTile participant={participant} videoTrack={null} />));
}

it("badges a phone, tablet or foldable tile with an icon that says where the person joined from", () => {
  renderTile({ id: "nora", displayName: "Nora", deviceHint: "iPhone", device: { label: "iPhone", joinedFrom: "iPhone", form: "phone" } });
  const badge = document.querySelector("[data-part='tile-device-badge']");
  expect(badge?.getAttribute("aria-label")).toBe("Joined from iPhone");
  expect(badge?.getAttribute("title")).toBeNull();
  expect(badge?.getAttribute("tabindex")).toBe("0");
  expect(badge?.textContent).toBe("");
  expect(badge?.querySelector("svg")).not.toBeNull();
  // The name tag does not repeat the device when it has no count to add.
  expect(document.querySelector("[data-part='tile-device']")).toBeNull();
});

it("leaves a computer's tile without a badge", () => {
  renderTile({ id: "sofia", displayName: "Sofia", deviceHint: "Mac", device: { label: "Mac", joinedFrom: "a Mac", form: "computer" } });
  expect(document.querySelector("[data-part='tile-device-badge']")).toBeNull();
  expect(document.querySelector("[data-part='tile-device']")).toBeNull();
});

it("leaves your own tile without a badge, since you know your device", () => {
  renderTile({ id: "me", displayName: "Nora", isLocal: true, deviceHint: "iPhone", device: { label: "iPhone", joinedFrom: "iPhone", form: "phone" } });
  expect(document.querySelector("[data-part='tile-device-badge']")).toBeNull();
});

it("keeps the device count in the name tag, and names a computer there since it has no badge", () => {
  renderTile({ id: "ada", displayName: "Ada", deviceHint: "iPad · 2 devices", device: { label: "iPad", joinedFrom: "iPad", form: "tablet" } });
  expect(document.querySelector("[data-part='tile-device-badge']")?.getAttribute("aria-label")).toBe("Joined from iPad");
  expect(document.querySelector("[data-part='tile-device']")?.textContent).toBe("· 2 devices");
  document.body.replaceChildren();
  renderTile({ id: "ada", displayName: "Ada", deviceHint: "Mac · 2 devices", device: { label: "Mac", joinedFrom: "a Mac", form: "computer" } });
  expect(document.querySelector("[data-part='tile-device']")?.textContent).toBe("Mac· 2 devices");
});
