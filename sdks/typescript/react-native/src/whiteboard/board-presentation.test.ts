import { ChalkWhiteboardV1Client, type Capability, type SpaceSnapshot, type SyncSocket } from "@q9labsai/chalk-client";
import { expect, it } from "vitest";
import { closeNativeBoard, presentNativeBoard, type NativeBoardPresentationTransport } from "./board-presentation";

const participantId = "20000000-0000-4000-8000-000000000002";
const sceneId = "10000000-0000-4000-8000-000000000001";

type WireFrame = { readonly type?: string; readonly operation_id?: string; readonly request_id?: string; readonly presenting?: boolean };

class FakeSocket implements SyncSocket {
  onopen: SyncSocket["onopen"] = null;
  onmessage: SyncSocket["onmessage"] = null;
  onclose: SyncSocket["onclose"] = null;
  onerror: SyncSocket["onerror"] = null;

  constructor(readonly sent: WireFrame[]) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as WireFrame);
  }

  close(): void {}

  open(): void {
    this.onopen?.();
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

function pickedDrawerSnapshot(): Pick<SpaceSnapshot, "self" | "whiteboard"> {
  const capabilities: readonly Capability[] = [];
  return {
    self: {
      participantId,
      displayName: "Participant",
      role: "guest",
      capabilities,
      handRaised: false,
      can: (capability) => capabilities.includes(capability),
    },
    whiteboard: {
      open: true,
      engine: { status: "ready", sceneId, revision: "1", presenting: false, error: null },
      access: { canDraw: true, policy: "picked", permissions: [{ participantId, canDraw: true }] },
    },
  };
}

function client() {
  return { getSnapshot: () => pickedDrawerSnapshot() };
}

function stage(events: string[]) {
  return {
    setBoardOpen: (open: boolean | null) => events.push(`open:${String(open)}`),
    showContent: () => events.push("content"),
    setFollowing: (participantId: string | null) => events.push(`follow:${String(participantId)}`),
  };
}

function transport(events: string[], failPresentation = false): NativeBoardPresentationTransport {
  return {
    startSceneSubscription: async () => {
      events.push("start");
    },
    setPresentation: async (presenting) => {
      events.push(`present:${String(presenting)}`);
      if (failPresentation) throw new Error("presentation rejected");
    },
  };
}

function wireTransport() {
  const sent: WireFrame[] = [];
  const closes: { code?: number; reason?: string }[] = [];
  const socketRef: { current?: FakeSocket } = {};
  let nextId = 0;
  const transport = new ChalkWhiteboardV1Client({
    url: "wss://sync.test/v1/whiteboard",
    token: async () => "token",
    webSocket: {
      connect: () => {
        socketRef.current = new FakeSocket(sent, closes);
        return socketRef.current;
      },
    },
    files: { getDownloadUrl: async () => ({ downloadUrl: "https://files.test/download", expiresAt: "2100-01-01T00:00:00.000Z" }) },
    ids: { next: () => `operation-0000000${++nextId}` },
    watchdog: false,
  });
  const summaries: unknown[] = [];
  transport.subscribeSummary((summary) => summaries.push(summary));
  return { closes, sent, socketRef, summaries, transport };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function startWireTransport(wire: ReturnType<typeof wireTransport>): Promise<FakeSocket> {
  const started = wire.transport.startSceneSubscription();
  await flush();
  const socket = wire.socketRef.current;
  if (!socket) throw new Error("whiteboard socket did not connect");
  socket.open();
  await flush();
  socket.receive({
    type: "welcome",
    protocol: "whiteboard-v1",
    participant_id: participantId,
    participant_generation: 1,
    capabilities: [],
    participant_capabilities: ["drawWhiteboard"],
    scene_id: sceneId,
    revision: "0",
    can_draw: true,
    presenting: false,
    presenter_id: null,
  });
  socket.receive({ type: "draw_access", policy: "picked", can_draw: true, capabilities: [], grants: [{ participant_id: participantId, can_draw: true }] });
  await flush();
  const request = wire.sent.find((frame) => frame.type === "request_snapshot");
  if (!request?.request_id) throw new Error(`whiteboard snapshot was not requested: sent=${JSON.stringify(wire.sent)} closes=${JSON.stringify(wire.closes)} summaries=${JSON.stringify(wire.summaries)}`);
  socket.receive({ type: "snapshot_page", request_id: request.request_id, scene_id: sceneId, revision: "0", page: 0, page_count: 1, elements: [], app_state: { view_background_color: "#ffffff" } });
  await flush();
  await started;
  return socket;
}

it("sends set_presentation before opening locally for a non-host drawer", async () => {
  const events: string[] = [];
  const wire = wireTransport();
  const socket = await startWireTransport(wire);
  const opening = presentNativeBoard(client(), stage(events), wire.transport);
  await flush();
  const frame = wire.sent.find((candidate) => candidate.type === "set_presentation");
  expect(frame).toMatchObject({ type: "set_presentation", presenting: true });
  if (!frame?.operation_id) throw new Error("set_presentation was not sent");
  socket.receive({ type: "commit", operation_id: frame.operation_id, outcome: "committed", scene_id: sceneId, revision: "1" });
  await opening;
  expect(wire.sent.map((candidate) => candidate.type)).toEqual(["hello", "request_snapshot", "snapshot_ack", "set_presentation"]);
  expect(events).toEqual(["open:true", "content"]);
  await wire.transport.stopSceneSubscription();
});

it("does not open locally when presenting fails", async () => {
  const events: string[] = [];
  await expect(presentNativeBoard(client(), stage(events), transport(events, true))).rejects.toThrow("presentation rejected");
  expect(events).toEqual(["start", "present:true"]);
});

it("does not open locally when presentation is unavailable", async () => {
  const events: string[] = [];
  const withoutPresentation: NativeBoardPresentationTransport = {
    startSceneSubscription: async () => {
      events.push("start");
    },
  };
  await expect(presentNativeBoard(client(), stage(events), withoutPresentation)).rejects.toThrow();
  expect(events).toEqual(["start"]);
});

it("ends the presentation before closing locally for a non-host drawer", async () => {
  const events: string[] = [];
  await closeNativeBoard(client(), stage(events), transport(events));
  expect(events).toEqual(["present:false", "open:false", "follow:null"]);
});
