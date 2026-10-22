import { ChalkWhiteboardViewBounds } from "@q9labsai/chalk-client";
import { Board as SharedBoard, type BoardProps as SharedBoardProps } from "@q9labsai/chalk-whiteboard/react";
import { useCan, useConnection, useSelf, useWhiteboard } from "../../bindings/hooks";
import { Avatar } from "../atomic/Avatar";

export type BoardProps = Omit<SharedBoardProps, "isHost" | "connectionStatus" | "sceneId" | "sceneStatus" | "ownParticipantId" | "viewBounds" | "renderCursorAvatar" | "onExport">;

const cursorAvatar = (name: string) => <Avatar name={name} size="xs" animated={false} className="chalk-board-cursor-avatar" />;

export function Board(props: BoardProps) {
  const isHost = useCan("manageWhiteboard");
  const connection = useConnection();
  const boardSession = useWhiteboard().engine;
  const self = useSelf();
  return <SharedBoard {...props} isHost={isHost} connectionStatus={connection.status} sceneId={boardSession.sceneId} sceneStatus={boardSession.status} ownParticipantId={self.participantId} viewBounds={ChalkWhiteboardViewBounds} renderCursorAvatar={cursorAvatar} />;
}
