import { PresentingReplica } from "../presenting/replica";
import type { V1ConnectionPhase, V1Socket } from "./v1-types";
import type { decodeInboundV1Frame } from "./v1-codec";

type InboundFrame = ReturnType<typeof decodeInboundV1Frame>;
type PresentingInboundFrame = Extract<InboundFrame, { readonly kind: "presenting" }>;

type PresentingState = {
  readonly socket: V1Socket | null;
  readonly phase: V1ConnectionPhase;
  readonly negotiated: boolean;
};

export function createV1PresentingReplica(state: () => PresentingState): PresentingReplica {
  return new PresentingReplica((wire) => {
    const current = state();
    if (!current.socket || current.phase !== "live" || !current.negotiated) return false;
    try {
      current.socket.send(wire);
      return true;
    } catch {
      return false;
    }
  });
}

export function receiveV1PresentingFrame(frame: InboundFrame, replica: PresentingReplica, negotiated: boolean, phase: V1ConnectionPhase): frame is PresentingInboundFrame {
  if (frame.kind !== "presenting") return false;
  if (negotiated && phase === "live") replica.receive(frame.value);
  return true;
}
