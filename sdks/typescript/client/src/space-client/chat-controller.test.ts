import { describe, expect, it } from "vitest";
import type { SyncV1ClientFrame, SyncV1ServerFrame } from "../generated/sync";
import { V1CollaborationState } from "../sync/v1-collaboration-state";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

type MessageFrame = Extract<SyncV1ServerFrame, { readonly type: "chat_message" }>;
type PageRequest = Extract<SyncV1ClientFrame, { readonly type: "chat_page_request" }>;
type SendRequest = Extract<SyncV1ClientFrame, { readonly type: "chat_send" }>;
const participantId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const peerId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
const id = (sequence: number) => `018f2f65-2a77-7a44-8e9a-${sequence.toString(16).padStart(12, "0")}`;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function message(sequence: number, author = peerId, clientMessageId = id(sequence)): MessageFrame {
  return { type: "chat_message", message_id: id(sequence), client_message_id: clientMessageId, sequence: String(sequence), participant_id: author, display_name: "Participant", text: `Message ${sequence}`, attachments: [], created_at: "2026-10-10T12:00:00.000Z" };
}

async function setup(initial: readonly MessageFrame[] = [], localParticipantId = participantId, drainInitial = true) {
  const platform = createCoreTestPlatform();
  const sent: SyncV1ClientFrame[] = [];
  const requests: PageRequest[] = [];
  const sendRequests = new Map<string, (frame: SendRequest) => void>();
  let requestId = 1000;
  const collaboration = new V1CollaborationState({
    request: undefined,
    requestIds: { next: () => id(++requestId) },
    maxPendingRequests: undefined,
    isLive: () => platform.sync.getSnapshot().connection.phase === "live",
    send: (frame) => {
      sent.push(frame);
      if (frame.type === "chat_page_request") requests.push(frame);
      if (frame.type === "chat_send") {
        sendRequests.get(frame.text)?.(frame);
        sendRequests.delete(frame.text);
      }
    },
    stateChanged: () => platform.emitSync(platform.sync.getSnapshot()),
  });
  collaboration.acceptWelcome({
    type: "welcome",
    protocol: 1,
    participant_id: participantId,
    participant_generation: 1,
    recovery_id: id(999),
    mode: "up_to_date",
    head: { revision: 0, state_schema_version: 1, state_digest: "0".repeat(64) },
    extensions: [{ name: "collaboration_v1", capabilities: ["sendChat"], participant_capabilities: {}, chat_head_sequence: initial.at(-1)?.sequence ?? null, retained_floor_sequence: initial[0]?.sequence ?? null, read_receipts: [] }],
  });
  const sync = {
    ...platform.sync,
    start: async () => {
      await platform.sync.start();
      platform.emitSync({ ...platform.sync.getSnapshot(), participantId: localParticipantId });
    },
    getCollaborationExtensionState: () => collaboration.getState(),
    subscribeCollaboration: collaboration.subscribe.bind(collaboration),
    sendChatMessage: collaboration.sendChatMessage.bind(collaboration),
    readChatPage: collaboration.readChatPage.bind(collaboration),
  };
  const access = opaqueAccessGrant("chat-catch-up");
  const client = createSpaceClientForPlatform({ space: "space-1", getAccess: async () => ({ ...access, subject: { ...access.subject, participant_id: localParticipantId } }) }, { ...platform, dependencies: { ...platform.dependencies, createSyncClient: () => sync } });
  await client.join({ microphone: false, camera: false });
  function head(sequence: number, floor = 1) {
    collaboration.chatHead({ type: "chat_head", head_sequence: String(sequence), retained_floor_sequence: String(floor) });
  }
  function phase(phase: "live" | "recovering") {
    platform.emitSync({ ...platform.sync.getSnapshot(), connection: { phase } });
  }
  function page(request: PageRequest, messages: readonly MessageFrame[], headSequence: number, hasMore = false, floor = 1) {
    collaboration.chatPage({ type: "chat_page", request_id: request.request_id, outcome: "loaded", messages, has_more: hasMore, head_sequence: String(headSequence), retained_floor_sequence: String(floor) });
  }
  async function drain(messages: readonly MessageFrame[]) {
    for (let turn = 0; turn < 30; turn += 1) {
      await settle();
      const request = requests.shift();
      if (!request) {
        await settle();
        if (requests.length === 0) return;
        continue;
      }
      const candidates = request.direction === "newer" ? messages.filter((item) => BigInt(item.sequence) > BigInt(request.cursor_sequence ?? "0")) : messages.filter((item) => request.cursor_sequence === null || BigInt(item.sequence) < BigInt(request.cursor_sequence));
      const batch = request.direction === "newer" ? candidates.slice(0, request.limit) : candidates.slice(-request.limit);
      page(request, batch, Number(messages.at(-1)?.sequence ?? "0"), candidates.length > batch.length, Number(messages[0]?.sequence ?? "1"));
    }
    throw new Error("Chat catch-up did not quiesce");
  }
  async function beginSend(sequence: number) {
    const text = `Message ${sequence}`;
    const emitted = new Promise<SendRequest>((resolve) => sendRequests.set(text, resolve));
    const pending = client.chat.send({ text });
    const request = await Promise.race([
      emitted,
      pending.then(() => {
        throw new Error("Send completed before acknowledgement");
      }),
    ]);
    const accepted = message(sequence, localParticipantId, request.client_message_id);
    return {
      message: accepted,
      acknowledge: async () => {
        collaboration.chatSendResult({ type: "chat_send_result", client_message_id: request.client_message_id, outcome: "accepted", message: accepted });
        await pending;
      },
    };
  }
  async function acknowledge(sequence: number) {
    const send = await beginSend(sequence);
    await send.acknowledge();
    return send.message;
  }
  if (drainInitial) await drain(initial);
  return { client, collaboration, sent, requests, head, phase, page, drain, beginSend, acknowledge, sequences: () => client.getSnapshot().chat.messages.map((item) => item.sequence) };
}

describe("Chat controller catch-up", () => {
  it("repairs the peer message skipped by a higher own-send acknowledgement before the head", async () => {
    const harness = await setup();
    try {
      // The observed order: peer commits 1, own acknowledgement 2, then head 2.
      // Sync fan-out sends heads only; message 1 must be pulled, not awaited.
      const own = await harness.acknowledge(2);
      harness.head(2);
      await harness.drain([message(1), own]);
      expect(harness.sequences()).toEqual(["1", "2"]);
      expect(harness.sent.filter((frame) => frame.type === "chat_page_request")).toMatchObject([{ direction: "newer", cursor_sequence: "0" }]);
    } finally {
      harness.client.dispose();
    }
  });

  it("does not mistake unloaded older history for a live delivery gap", async () => {
    const history = Array.from({ length: 250 }, (_, index) => message(index + 1));
    const harness = await setup(history);
    try {
      expect(harness.sequences()).toEqual(history.slice(-100).map((item) => item.sequence));
      const own = await harness.acknowledge(252);
      harness.head(252);
      await harness.drain([...history, message(251), own]);
      expect(harness.sequences()).toEqual([...history.slice(-100), message(251), own].map((item) => item.sequence));
      expect(harness.sent.filter((frame) => frame.type === "chat_page_request")).toMatchObject([
        { direction: "older", cursor_sequence: null },
        { direction: "newer", cursor_sequence: "250" },
      ]);
    } finally {
      harness.client.dispose();
    }
  });

  it("repairs a gap beyond an in-flight page even when that page has no more results", async () => {
    const harness = await setup();
    try {
      harness.head(1);
      await settle();
      const request = harness.requests.shift();
      if (!request) throw new Error("Expected first page request");
      const own = await harness.acknowledge(3);
      harness.page(request, [message(1)], 1);
      await harness.drain([message(1), message(2), own]);
      expect(harness.sequences()).toEqual(["1", "2", "3"]);
    } finally {
      harness.client.dispose();
    }
  });

  it("anchors an initial history page before interleaved own acknowledgements", async () => {
    const history = Array.from({ length: 250 }, (_, index) => message(index + 1));
    const harness = await setup(history, participantId, false);
    try {
      const own = await harness.acknowledge(252);
      const request = harness.requests.shift();
      if (!request) throw new Error("Expected initial history page");
      harness.page(request, history.slice(-100), 250, true);
      await harness.drain([...history, message(251), own]);
      expect(harness.sequences()).toEqual([...history.slice(-100), message(251), own].map((item) => item.sequence));
    } finally {
      harness.client.dispose();
    }
  });

  it("repairs gaps that precede the bounded visible list", async () => {
    const harness = await setup();
    const messages = Array.from({ length: 602 }, (_, index) => message(index + 1));
    try {
      for (const item of messages.slice(1)) harness.collaboration.chatMessage(item);
      harness.head(602);
      await harness.drain(messages);
      expect(harness.sequences()).toEqual(messages.slice(-500).map((item) => item.sequence));
    } finally {
      harness.client.dispose();
    }
  });

  it("reanchors after retention resets without requesting expired messages again", async () => {
    const harness = await setup([message(1)]);
    try {
      harness.head(10, 8);
      await settle();
      const request = harness.requests.shift();
      if (!request) throw new Error("Expected catch-up request");
      harness.collaboration.chatPage({ type: "chat_page", request_id: request.request_id, outcome: "cursor_reset", retained_floor_sequence: "8" });
      await harness.drain([message(8), message(9), message(10)]);
      harness.head(11, 8);
      await harness.drain([message(8), message(9), message(10), message(11)]);
      expect(harness.sequences()).toEqual(["8", "9", "10", "11"]);
    } finally {
      harness.client.dispose();
    }
  });

  it("keeps normal catch-up cost at zero per own message and one per peer head", async () => {
    const harness = await setup();
    const messages: MessageFrame[] = [];
    try {
      for (let sequence = 1; sequence <= 100; sequence += 1) {
        messages.push(await harness.acknowledge(sequence));
        harness.head(sequence);
        await harness.drain(messages);
      }
      expect(harness.sent.filter((frame) => frame.type === "chat_page_request")).toHaveLength(0);
      for (let sequence = 101; sequence <= 200; sequence += 1) {
        messages.push(message(sequence));
        harness.head(sequence);
        await harness.drain(messages);
      }
      expect(harness.sent.filter((frame) => frame.type === "chat_page_request")).toHaveLength(100);
      expect(harness.sequences()).toEqual(messages.map((item) => item.sequence));
    } finally {
      harness.client.dispose();
    }
  });

  it("keeps own-send catch-up cost at zero when a new Episode starts above sequence 1", async () => {
    const harness = await setup();
    const messages: MessageFrame[] = [];
    try {
      for (let sequence = 101; sequence <= 110; sequence += 1) {
        messages.push(await harness.acknowledge(sequence));
        harness.head(sequence, 101);
        await harness.drain(messages);
      }
      expect(harness.sent.filter((frame) => frame.type === "chat_page_request")).toHaveLength(0);
      expect(harness.sequences()).toEqual(messages.map((item) => item.sequence));
    } finally {
      harness.client.dispose();
    }
  });

  it("converges on both participants under seeded random acknowledgements, deliveries, heads and reconnects", async () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      let state = seed;
      const random = () => {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
      };
      const participants = [await setup(), await setup([], peerId)];
      const messages: MessageFrame[] = [];
      const actions: (() => Promise<void>)[] = [];
      const pending = [false, false];
      let sequence = 1;
      // Both participants send into one durable stream. Commit order assigns
      // sequences. Each participant's command queue allows one pending send;
      // delivery and acknowledgements across participants remain independent.
      try {
        while (sequence <= 40 || actions.length > 0) {
          const available = [0, 1].filter((owner) => !pending[owner]);
          if (sequence <= 40 && available.length > 0 && (actions.length === 0 || random() < 0.4)) {
            const owner = available[Math.floor(random() * available.length)]!;
            const send = await participants[owner]!.beginSend(sequence++);
            const item = send.message;
            messages.push(item);
            pending[owner] = true;
            actions.push(async () => {
              await send.acknowledge();
              pending[owner] = false;
            });
            if (random() > 0.35)
              actions.push(async () => {
                participants[1 - owner]!.collaboration.chatMessage(item);
              });
            if (random() > 0.25)
              actions.push(async () => {
                for (const participant of participants) participant.head(Number(item.sequence));
              });
          } else {
            const action = actions.splice(Math.floor(random() * actions.length), 1)[0]!;
            await action();
          }
          if (random() < 0.1) {
            const participant = participants[Math.floor(random() * participants.length)]!;
            participant.phase("recovering");
            await settle();
            participant.phase("live");
          }
          if (random() < 0.15) for (const participant of participants) await participant.drain(messages);
        }
        for (const participant of participants) {
          participant.head(40);
          await participant.drain(messages);
          expect(participant.sequences(), `seed ${seed}`).toEqual(messages.map((item) => item.sequence));
        }
      } finally {
        for (const participant of participants) participant.client.dispose();
      }
    }
  }, 60_000);
});
