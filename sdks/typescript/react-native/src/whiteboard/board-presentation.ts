import { canDrawWhiteboard, type ChalkWhiteboardV1Transport, type SpaceSnapshot } from "@q9labsai/chalk-client";

export type NativeBoardPresentationClient = {
  readonly getSnapshot: () => Pick<SpaceSnapshot, "self" | "whiteboard">;
};

export type NativeBoardPresentationStage = {
  readonly setBoardOpen: (open: boolean | null) => void;
  readonly showContent: () => void;
  readonly setFollowing: (participantId: string | null) => void;
};

export type NativeBoardPresentationTransport = Pick<ChalkWhiteboardV1Transport, "startSceneSubscription" | "setPresentation">;

export async function presentNativeBoard(client: NativeBoardPresentationClient, stage: NativeBoardPresentationStage, transport: NativeBoardPresentationTransport): Promise<void> {
  await transport.startSceneSubscription();
  requireCanPresent(client);
  if (!transport.setPresentation) throw new Error("Whiteboard presentation is unavailable.");
  await transport.setPresentation(true);
  stage.setBoardOpen(true);
  stage.showContent();
}

export async function closeNativeBoard(client: NativeBoardPresentationClient, stage: NativeBoardPresentationStage, transport: NativeBoardPresentationTransport): Promise<void> {
  requireCanPresent(client);
  if (!transport.setPresentation) throw new Error("Whiteboard presentation is unavailable.");
  await transport.setPresentation(false);
  stage.setBoardOpen(false);
  stage.setFollowing(null);
}

function requireCanPresent(client: NativeBoardPresentationClient): void {
  const snapshot = client.getSnapshot();
  if (!canDrawWhiteboard(snapshot.whiteboard, snapshot.self.can("drawWhiteboard"))) {
    throw new Error("Whiteboard draw permission is required.");
  }
}
