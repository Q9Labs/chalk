import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { PreviewSpaceView, createPreviewClient, type WhiteboardViewProps } from "@q9labsai/chalk-react/preview";
import type { ChalkWhiteboardView } from "@q9labsai/chalk-client";
import type { WhiteboardWireElement, WhiteboardCollaborationEvent } from "@q9labsai/chalk-whiteboard";
import { HOST, liveSnapshot } from "./fixtures";

type Message = { readonly type: "presentation"; readonly presenterId: string | null } | WhiteboardCollaborationEvent;

/** Browser fixture: real SpaceView and board, with an in-memory two-tab transport. */
function FollowPinCall({ self, room }: { readonly self: "a" | "b"; readonly room: string }) {
  const other = self === "a" ? "b" : "a";
  const name = (id: string) => (id === "a" ? "Amina" : "Omar");
  const [presenterId, setPresenterId] = useState<string | null>(null);
  const [channel] = useState(() => new BroadcastChannel(room));
  const [listeners] = useState(() => new Set<(event: WhiteboardCollaborationEvent) => void>());
  const [client] = useState(() => {
    const snapshot = liveSnapshot({ self: { camera: false, microphone: false }, others: [{ id: other, name: name(other), camera: false, microphone: false }], capabilities: HOST });
    return createPreviewClient({
      ...snapshot,
      self: { ...snapshot.self, participantId: self, displayName: name(self) },
      participants: { ...snapshot.participants, roster: snapshot.participants.roster.map((person) => (person.participantId === "you" ? { ...person, participantId: self, displayName: name(self) } : person)) },
    });
  });
  const receive = (event: Message) => {
    if (event.type === "presentation") {
      setPresenterId(event.presenterId);
      client.updateSnapshot((current) => ({ ...current, whiteboard: { ...current.whiteboard, engine: { ...current.whiteboard.engine, status: "ready", sceneId: "scene-1", presenting: event.presenterId !== null } } }));
    } else for (const listener of listeners) listener(event);
  };
  const send = (event: Message) => {
    receive(event);
    channel.postMessage(event);
  };
  useEffect(() => {
    channel.onmessage = (event: MessageEvent<Message>) => receive(event.data);
    return () => {
      channel.close();
      client.dispose();
    };
  }, [channel, client]);
  const [board] = useState<WhiteboardViewProps>(() => ({
    canDraw: true,
    collab: {
      subscribe: (listener: (event: WhiteboardCollaborationEvent) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      requestSnapshot: async () => {
        for (const listener of listeners) listener({ type: "snapshot", sceneId: "scene-1", revision: "0", elements: [] });
      },
      submitUpdate: async (input: { readonly elements: readonly WhiteboardWireElement[] }) => {
        send({ type: "update", sceneId: "scene-1", revision: "1", elements: input.elements });
        return { operationId: "update", sceneId: "scene-1", revision: "1" };
      },
      clear: async () => {
        send({ type: "snapshot", sceneId: "scene-1", revision: "0", elements: [] });
        return { operationId: "clear", sceneId: "scene-1", revision: "0" };
      },
      sendCursor: () => true,
    },
  }));
  return (
    <main className="h-dvh">
      <PreviewSpaceView
        client={client}
        spaceName="Participant controls proof"
        callLinkOpen={false}
        generatedAvatars={false}
        features={{ sounds: false, recording: false }}
        onToggleWhiteboard={() => send({ type: "presentation", presenterId: presenterId ? null : self })}
        whiteboard={
          presenterId
            ? {
                isOpen: true,
                presenterId,
                props: board,
                sendView: (view: ChalkWhiteboardView) => {
                  send({ ...view, type: "view", participantId: self, displayName: name(self), occurredAt: new Date().toISOString() });
                  return true;
                },
              }
            : undefined
        }
      />
    </main>
  );
}

class FollowPinFixture extends HTMLElement {
  mount(self: "a" | "b", room: string) {
    const target = document.getElementById("root");
    if (!target) throw new Error("Missing fixture root");
    target.replaceChildren();
    const host = document.createElement("div");
    target.appendChild(host);
    const root = createRoot(host);
    root.render(<FollowPinCall self={self} room={room} />);
    return () => root.unmount();
  }
}
customElements.define("chalk-follow-pin-fixture", FollowPinFixture);
declare global {
  interface HTMLElementTagNameMap {
    "chalk-follow-pin-fixture": FollowPinFixture;
  }
}
