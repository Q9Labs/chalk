import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WSClient } from "../ws-client.ts";
import { wideEvents, type WideEvent } from "../wide-events/index.ts";
import { serializeOutgoingMessage } from "../ws-client/outbound.ts";

class MockWebSocket {
  url: string;
  protocols: string[];
  readyState = WebSocket.CONNECTING;

  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  sent: string[] = [];

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  open() {
    this.readyState = WebSocket.OPEN;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }
}

const makeFakeTimers = () => {
  let nextId = 1;
  const intervals = new Map<number, () => void>();
  const timeouts = new Map<number, () => void>();

  return {
    timers: {
      setInterval: (cb: () => void, _ms: number) => {
        const id = nextId++;
        intervals.set(id, cb);
        return id;
      },
      clearInterval: (id: number) => {
        intervals.delete(id);
      },
      setTimeout: (cb: () => void, _ms: number) => {
        const id = nextId++;
        timeouts.set(id, cb);
        return id;
      },
      clearTimeout: (id: number) => {
        timeouts.delete(id);
      },
    },
    intervals,
    timeouts,
  };
};

describe("WSClient", () => {
  let capturedWideEvents: WideEvent[] = [];

  beforeEach(() => {
    capturedWideEvents = [];
    wideEvents.reset();
    wideEvents.configure({
      enabled: true,
      includeDebugInfo: true,
      handler: (event) => {
        capturedWideEvents.push(event);
      },
    });
  });

  afterEach(() => {
    wideEvents.reset();
    wideEvents.configure({
      enabled: false,
      includeDebugInfo: false,
      handler: undefined,
    });
  });

  it("decodes participant.joined (nested) + emits Participant", () => {
    let ws: MockWebSocket | null = null;

    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    let got: any;
    client.on("participant.joined", (p) => {
      got = p;
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.receive({
      type: "participant.joined",
      payload: { participant: { id: "p1", display_name: "Alice" } },
    });

    expect(got).toBeDefined();
    expect(got.id).toBe("p1");
    expect(got.displayName).toBe("Alice");
    expect(got.role).toBe("participant");
    expect(got.videoEnabled).toBe(false);
  });

  it("accepts legacy event/data envelopes for participant.joined", () => {
    let ws: MockWebSocket | null = null;

    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    let got: any;
    client.on("participant.joined", (p) => {
      got = p;
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.receive({
      event: "participant.joined",
      data: {
        participant_id: "p2",
        room_id: "room_1",
        display_name: "Bob",
        role: "host",
      },
    });

    expect(got).toBeDefined();
    expect(got.id).toBe("p2");
    expect(got.displayName).toBe("Bob");
    expect(got.role).toBe("host");
  });

  it("accepts legacy event/data envelopes for participant.left", () => {
    let ws: MockWebSocket | null = null;

    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    let got: any;
    client.on("participant.left", (payload) => {
      got = payload;
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.receive({
      event: "participant.left",
      data: {
        participant_id: "p2",
        room_id: "room_1",
      },
    });

    expect(got).toEqual({ participantId: "p2" });
  });

  it("decodes chat.message + converts timestamp to Date", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    let got: any;
    client.on("chat.message", (m) => {
      got = m;
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.receive({
      type: "chat.message",
      payload: {
        id: "m1",
        participant_id: "p1",
        display_name: "Alice",
        content: "hi",
        timestamp: "2026-02-05T00:00:00.000Z",
      },
    });

    expect(got.senderId).toBe("p1");
    expect(got.senderName).toBe("Alice");
    expect(got.content).toBe("hi");
    expect(got.timestamp instanceof Date).toBe(true);
  });

  it("decodes reaction + falls back participantName", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    let got: any;
    client.on("reaction", (r) => {
      got = r;
    });

    client.connect("tok", "room_1");
    ws?.open();

    ws?.receive({
      type: "reaction",
      payload: {
        participant_id: "p1",
        emoji: "👍",
        timestamp: "2026-02-05T00:00:00.000Z",
      },
    });

    expect(got.participantId).toBe("p1");
    expect(got.participantName).toBe("Unknown");
    expect(got.timestamp instanceof Date).toBe(true);
  });

  it("decodes whiteboard.data + converts timestamp to Date", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    let got: any;
    client.on("whiteboard.data", (d) => {
      got = d;
    });

    client.connect("tok", "room_1");
    ws?.open();

    ws?.receive({
      type: "whiteboard.data",
      payload: {
        schema_version: 2,
        scene_id: "scene-1",
        sync_all: false,
        participant_id: "p1",
        display_name: "Alice",
        elements: [],
        seq: 1,
        timestamp: "2026-02-05T00:00:00.000Z",
      },
    });

    expect(got.participantId).toBe("p1");
    expect(got.timestamp instanceof Date).toBe(true);
  });

  it("emits WS_PARSE_ERROR on invalid payload", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    let got: any;
    client.on("error", (e) => {
      got = e;
    });

    client.connect("tok", "room_1");
    ws?.open();

    ws?.receive({
      type: "chat.message",
      payload: { id: "m1" }, // invalid shape
    });

    expect(got).toBeDefined();
    expect(got.code).toBe("WS_PARSE_ERROR");
    expect(capturedWideEvents.some((event) => event.eventType === "websocket.error" && event.error?.code === "WS_PARSE_ERROR")).toBe(true);
  });

  it("serializes transcript with camelCase payload keys", () => {
    const json = serializeOutgoingMessage({
      type: "transcript",
      payload: {
        id: "t1",
        participantId: "p1",
        speakerName: "Alice",
        text: "hello",
        timestamp: "2026-02-05T00:00:00.000Z",
      },
    });

    const parsed = JSON.parse(json);
    expect(parsed.type).toBe("transcript");
    expect(parsed.payload.participantId).toBe("p1");
    expect(parsed.payload.participant_id).toBeUndefined();
  });

  it("serializes non-transcript payloads as snake_case", () => {
    const json = serializeOutgoingMessage({
      type: "permission.grant",
      payload: { participantId: "p1", feature: "whiteboard" },
    });

    const parsed = JSON.parse(json);
    expect(parsed.payload.participant_id).toBe("p1");
    expect(parsed.payload.participantId).toBeUndefined();
  });

  it("serializes whiteboard.update v2 without transforming element keys", () => {
    const json = serializeOutgoingMessage({
      type: "whiteboard.update",
      payload: {
        schemaVersion: 2,
        sceneId: "scene-1",
        syncAll: false,
        elements: [{ id: "el1", isDeleted: true, versionNonce: 1 }],
        seq: 1,
      },
    });

    const parsed = JSON.parse(json);
    expect(parsed.payload.schema_version).toBe(2);
    expect(parsed.payload.scene_id).toBe("scene-1");
    expect(parsed.payload.sync_all).toBe(false);
    expect(parsed.payload.elements[0].isDeleted).toBe(true);
    expect(parsed.payload.elements[0].is_deleted).toBeUndefined();
  });

  it("heartbeat timeout triggers reconnecting", () => {
    const { timers, intervals } = makeFakeTimers();

    let ws: MockWebSocket | null = null;
    let now = 0;

    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
      timers: timers as any,
      now: () => now,
    });

    let attempt = 0;
    client.on("reconnecting", (d) => {
      attempt = d.attempt;
    });

    client.connect("tok", "room_1");
    ws?.open();

    // HEARTBEAT_TIMEOUT_MS = 30s * 2.5
    now = 75_001;
    const heartbeat = Array.from(intervals.values())[0];
    heartbeat?.();

    expect(client.connectionState).toBe("reconnecting");
    expect(attempt).toBe(1);
  });

  it("emits websocket close and reconnect diagnostics for unexpected closes", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.close(1013, "Try again later");

    const disconnectEvent = capturedWideEvents.find((event) => event.eventType === "websocket.disconnect" && event.data.reason === "socket_closed");
    const reconnectEvent = capturedWideEvents.find((event) => event.eventType === "websocket.reconnect" && event.data.trigger === "socket_closed");

    expect(disconnectEvent).toBeDefined();
    expect(disconnectEvent?.error?.code).toBe("WS_CLOSED");
    expect(disconnectEvent?.data.closeCode).toBe(1013);
    expect(disconnectEvent?.data.closeReason).toBe("Try again later");
    expect(reconnectEvent).toBeDefined();
    expect(reconnectEvent?.data.attempt).toBe(1);
    expect(reconnectEvent?.data.delayMs).toBe(1000);
  });

  it("uses the updated token provider for reconnects after join", async () => {
    const { timers, timeouts } = makeFakeTimers();
    const sockets: MockWebSocket[] = [];
    const rootTokenProvider = vi.fn(async () => "root_token");
    const sessionTokenProvider = vi.fn(async () => "session_refreshed");

    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        const ws = new MockWebSocket(url, protocols);
        sockets.push(ws);
        return ws as unknown as WebSocket;
      },
      timers: timers as any,
      tokenProvider: rootTokenProvider,
    });

    client.connect("joined_token", "room_1");
    sockets[0]?.open();
    client.setTokenProvider(sessionTokenProvider);

    sockets[0]?.close(1011, "server error");
    const reconnect = Array.from(timeouts.values())[0];
    await reconnect?.();

    expect(rootTokenProvider).not.toHaveBeenCalled();
    expect(sessionTokenProvider).toHaveBeenCalledTimes(1);
    expect(sockets[1]?.protocols[1]).toBe("token.session_refreshed");
  });

  it("emits websocket error diagnostics for socket runtime errors", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.onerror?.({
      type: "error",
      message: "socket blew up",
    });

    const errorEvent = capturedWideEvents.find((event) => event.eventType === "websocket.error" && event.data.stage === "socket");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.error?.code).toBe("WS_ERROR");
    expect(errorEvent?.error?.message).toContain("socket blew up");
  });

  it("emits outbound interaction diagnostics for reaction and moderation actions", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    client.connect("tok", "room_1");
    ws?.open();
    client.sendReaction("🔥");
    client.muteParticipant("p2");
    client.unmuteParticipant("p2");

    expect(capturedWideEvents.some((event) => event.eventType === "reaction.send" && event.data.emoji === "🔥")).toBe(true);
    expect(capturedWideEvents.some((event) => event.eventType === "participant.mute.request" && event.data.participantId === "p2")).toBe(true);
    expect(capturedWideEvents.some((event) => event.eventType === "participant.unmute.request" && event.data.participantId === "p2")).toBe(true);
  });

  it("emits outbound chat diagnostics with transport details", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    client.connect("tok", "room_1");
    ws?.open();
    client.sendChatMessage("hello world", ["a1", "a2"]);

    expect(capturedWideEvents.some((event) => event.eventType === "chat.send" && event.data.transport === "ws" && event.data.contentLength === 11 && event.data.attachmentCount === 2)).toBe(true);
  });

  it("emits inbound interaction diagnostics for reaction, hand raise, and moderation events", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.receive({
      type: "reaction",
      payload: {
        participant_id: "p1",
        display_name: "Alice",
        emoji: "👏",
        timestamp: "2026-02-05T00:00:00.000Z",
      },
    });
    ws?.receive({
      type: "hand.raised",
      payload: { participant_id: "p1" },
    });
    ws?.receive({
      type: "participant.mute",
      payload: { participant_id: "p2" },
    });

    expect(capturedWideEvents.some((event) => event.eventType === "reaction.receive" && event.data.emoji === "👏")).toBe(true);
    expect(capturedWideEvents.some((event) => event.eventType === "hand.raise" && event.data.direction === "receive" && event.data.participantId === "p1")).toBe(true);
    expect(capturedWideEvents.some((event) => event.eventType === "participant.mute.receive" && event.data.participantId === "p2")).toBe(true);
  });

  it("emits inbound chat diagnostics for messages and read receipts", () => {
    let ws: MockWebSocket | null = null;
    const client = new WSClient("wss://example/ws", {
      webSocketFactory: (url, protocols) => {
        ws = new MockWebSocket(url, protocols);
        return ws as unknown as WebSocket;
      },
    });

    client.connect("tok", "room_1");
    ws?.open();
    ws?.receive({
      type: "chat.message",
      payload: {
        id: "m1",
        participant_id: "p1",
        display_name: "Alice",
        content: "hello",
        timestamp: "2026-02-05T00:00:00.000Z",
        attachments: [
          {
            id: "att-1",
            file_name: "hello.png",
            mime_type: "image/png",
            size_bytes: 123,
            kind: "image",
          },
        ],
      },
    });
    ws?.receive({
      type: "chat.read",
      payload: {
        message_ids: ["m1", "m2"],
        participant_id: "p2",
        display_name: "Bob",
        read_at: "2026-02-05T00:00:01.000Z",
      },
    });

    expect(capturedWideEvents.some((event) => event.eventType === "chat.message.receive" && event.data.participantId === "p1" && event.data.contentLength === 5)).toBe(true);
    expect(capturedWideEvents.some((event) => event.eventType === "chat.read.receive" && event.data.participantId === "p2" && event.data.messageCount === 2)).toBe(true);
  });
});
