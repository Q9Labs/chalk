// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Capability, Participant, SpaceSnapshot } from "@q9labsai/chalk-client";
import { afterEach, expect, it, vi } from "vitest";
import { SpaceClientContext } from "../../bindings/context";
import { useParticipants } from "../../bindings/hooks";
import { createPreviewClient, createSnapshot, type PreviewClientCommand } from "../../test-support/preview-client";
import { useHostControls } from "./useHostControls";

afterEach(() => document.body.replaceChildren());

const HOST: readonly Capability[] = ["manageAdmission", "muteOthers"];

function person(id: string, microphone: "active" | "inactive"): Participant {
  return {
    participantId: id,
    displayName: id,
    role: "guest",
    eligibleRoles: ["guest"],
    capabilities: [],
    handRaised: false,
    media: { microphone, camera: "inactive", screenShare: "inactive" },
    presence: { state: "connected", speaking: false, activeSpeaker: false },
  };
}

function snapshot(capabilities: readonly Capability[], roster: readonly Participant[]): SpaceSnapshot {
  const base = createSnapshot(capabilities);
  return { ...base, self: { ...base.self, participantId: "me" }, participants: { roster, admissionQueue: [], admissionPolicy: "open" } };
}

function mount(initial: SpaceSnapshot) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const commands: PreviewClientCommand[] = [];
  const client = createPreviewClient(initial, { onCommand: (command) => void commands.push(command) });
  let seen: ReturnType<typeof useHostControls> | undefined;
  function Probe() {
    seen = useHostControls(useParticipants(), "me");
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() =>
    root.render(
      <SpaceClientContext.Provider value={client}>
        <Probe />
      </SpaceClientContext.Provider>,
    ),
  );
  return { commands, controls: () => seen?.hostHeader.hostControls };
}

const roster = [person("me", "active"), person("nora", "active"), person("sofia", "inactive"), person("akash", "active")];

it("offers a host Mute everyone, counting only the other people who are unmuted", () => {
  const { controls } = mount(snapshot(HOST, roster));
  expect(controls()?.muteEveryone?.unmutedCount).toBe(2);
});

it("offers a guest nothing", () => {
  expect(mount(snapshot([], roster)).controls()).toBeUndefined();
});

it("leaves out Mute everyone without the capability to mute others", () => {
  expect(mount(snapshot(["manageAdmission"], roster)).controls()?.muteEveryone).toBeUndefined();
});

it("leaves out Mute everyone when the host is alone", () => {
  const { controls } = mount(snapshot(HOST, [person("me", "active")]));
  expect(controls()).toBeUndefined();
});

it("mutes only the unmuted others", async () => {
  const { commands, controls } = mount(snapshot(HOST, roster));
  await act(async () => controls()?.muteEveryone?.onMute());
  expect(commands.map((command) => command.type)).toEqual(["mute", "mute"]);
  expect(commands.flatMap((command) => (command.type === "mute" ? [command.participantId] : []))).toEqual(["nora", "akash"]);
});
