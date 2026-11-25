// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Participant } from "@q9labsai/chalk-client";
import { afterEach, expect, it, vi } from "vitest";
import { SpaceClientContext } from "../../bindings/context";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { ParticipantsPanel } from "./ParticipantsPanel";

afterEach(() => document.body.replaceChildren());

const person = (id: string): Participant => ({
  participantId: id,
  displayName: id,
  role: "guest",
  eligibleRoles: ["guest"],
  capabilities: [],
  handRaised: false,
  media: { microphone: "active", camera: "inactive", screenShare: "inactive" },
  presence: { state: "connected", speaking: false, activeSpeaker: false },
});

it("lists the people and leaves the call-wide host controls to the call menu", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const base = createSnapshot(["manageAdmission", "muteOthers", "removeParticipant"]);
  const client = createPreviewClient({ ...base, self: { ...base.self, participantId: "me" }, participants: { roster: [person("me"), person("nora"), person("sofia")], admissionQueue: [], admissionPolicy: "open" } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <SpaceClientContext.Provider value={client}>
        <ParticipantsPanel />
      </SpaceClientContext.Provider>,
    ),
  );
  const text = document.body.textContent ?? "";
  expect(text).toContain("nora");
  expect(text).toContain("sofia");
  expect(text).not.toContain("Anyone with the link");
  expect(document.querySelector("[aria-label^='Who can join']")).toBeNull();
  expect(text).not.toContain("Mute everyone");
  expect(document.querySelector("[aria-label='People']")).not.toBeNull();
});

it("marks agent participants in the people list", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const base = createSnapshot([]);
  const agent = { ...person("agent"), identityKind: "agent" as const, description: "AI teammate" };
  const client = createPreviewClient({ ...base, self: { ...base.self, participantId: "me" }, participants: { roster: [person("me"), agent], admissionQueue: [], admissionPolicy: "open" } });
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <SpaceClientContext.Provider value={client}>
        <ParticipantsPanel />
      </SpaceClientContext.Provider>,
    ),
  );
  expect(document.querySelectorAll("[aria-label='AI participant']")).toHaveLength(1);
  expect(document.body.textContent ?? "").toContain("AI teammate");
});
