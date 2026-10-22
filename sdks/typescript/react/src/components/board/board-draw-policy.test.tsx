// @vitest-environment jsdom
import type { ChalkWhiteboardV1Transport, Participant, SpaceSnapshot } from "@q9labsai/chalk-client";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ChalkProvider } from "../../bindings/context";
import { useCanDrawWhiteboard } from "../../bindings/hooks";
import { createPreviewClient, createSnapshot } from "../../test-support/preview-client";
import { useWhoCanDraw, type WhoCanDraw } from "./board-draw-policy";
import { BoardMenu } from "./BoardMenu";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const HOST = ["drawWhiteboard", "manageWhiteboard"] as const;
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("draws only when Sync says so once the board subscription is live, whatever the role allows", async () => {
  const client = createPreviewClient(createSnapshot(["drawWhiteboard"]));
  const seen: boolean[] = [];
  function Probe() {
    seen.push(useCanDrawWhiteboard());
    return null;
  }
  await mount(client, <Probe />);
  expect(seen.at(-1)).toBe(true);

  await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, whiteboard: { ...snapshot.whiteboard, engine: { ...snapshot.whiteboard.engine, status: "ready" }, access: { canDraw: false, policy: "hosts", permissions: [] } } })));
  expect(seen.at(-1)).toBe(false);
});

it("offers hosts the people who are not hosts, with their picks, and sends the host's changes", async () => {
  const setDrawPolicy = vi.fn(async () => undefined);
  const setDrawPermission = vi.fn(async () => undefined);
  const client = hostClient({ setDrawPolicy, setDrawPermission });
  let control: WhoCanDraw | undefined;
  function Probe() {
    control = useWhoCanDraw(() => undefined);
    return null;
  }
  await mount(client, <Probe />);

  expect(control?.policy).toBe("picked");
  expect(control?.people).toEqual([
    { id: "nora", name: "Nora Patel", picked: true },
    { id: "akash", name: "Akash Rao", picked: false },
  ]);
  control?.onPolicy("hosts");
  control?.onPick("akash", true);
  expect(setDrawPolicy).toHaveBeenCalledWith("hosts");
  expect(setDrawPermission).toHaveBeenCalledWith("akash", true);

  await act(async () => client.updateSnapshot((snapshot) => ({ ...snapshot, self: { ...snapshot.self, capabilities: ["drawWhiteboard"], can: (capability) => capability === "drawWhiteboard" } })));
  expect(control).toBeUndefined();
});

it("shows the picker's empty states in the host's board menu", async () => {
  const onPick = vi.fn();
  const menu = (people: WhoCanDraw["people"]) => <BoardMenu surface="chalkboard" onSurface={() => undefined} onPlace={() => undefined} onDownload={() => undefined} onCopy={() => undefined} whoCanDraw={{ policy: "picked", people, onPolicy: () => undefined, onPick }} />;
  const container = await mount(createPreviewClient(), menu([]));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Board menu"]')?.click());
  expect(document.body.textContent).toContain("Who can draw");
  expect(document.body.textContent).toContain("No one else is here yet. Hosts can always draw.");

  for (const cleanup of cleanups.splice(0)) await cleanup();
  const next = await mount(createPreviewClient(), menu([{ id: "nora", name: "Nora Patel", picked: false }]));
  await act(async () => next.querySelector<HTMLButtonElement>('button[aria-label="Board menu"]')?.click());
  expect(document.body.textContent).toContain("Only hosts can draw until you pick someone.");
  const nora = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find((item) => item.textContent?.includes("Nora Patel"));
  await act(async () => (nora as HTMLElement | undefined)?.click());
  expect(onPick).toHaveBeenCalledWith("nora", true);
});

function hostClient(transport: Pick<ChalkWhiteboardV1Transport, "setDrawPolicy" | "setDrawPermission">) {
  const roster = [person("self", "Hasan Shoaib", [...HOST]), person("nora", "Nora Patel", ["drawWhiteboard"]), person("cohost", "Sara Malik", [...HOST]), person("akash", "Akash Rao", [])];
  const base = createSnapshot([...HOST]);
  const snapshot: SpaceSnapshot = {
    ...base,
    self: { ...base.self, participantId: "self" },
    participants: { roster, admissionQueue: [] },
    whiteboard: {
      ...base.whiteboard,
      engine: { ...base.whiteboard.engine, status: "ready" },
      access: {
        canDraw: true,
        policy: "picked",
        permissions: [
          { participantId: "nora", canDraw: true },
          { participantId: "akash", canDraw: false },
        ],
      },
    },
  };
  const client = createPreviewClient(snapshot);
  return Object.assign(client, { whiteboard: { transport: () => transport as ChalkWhiteboardV1Transport } });
}

function person(participantId: string, displayName: string, capabilities: Participant["capabilities"]): Participant {
  return {
    participantId,
    displayName,
    role: "guest",
    eligibleRoles: ["guest"],
    capabilities,
    handRaised: false,
    media: { microphone: "inactive", camera: "inactive", screenShare: "inactive" },
    presence: { state: "connected", speaking: false, activeSpeaker: false },
  };
}

async function mount(client: ReturnType<typeof createPreviewClient>, element: React.ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ChalkProvider client={client}>{element}</ChalkProvider>));
  cleanups.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}
