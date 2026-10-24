import { useContext, useMemo } from "react";
import { useWhoCanDraw } from "./board-draw-policy";
import { ChalkWhiteboardViewBounds } from "@q9labsai/chalk-client";
import { Board as SharedBoard, BoardToastContext, type BoardProps as SharedBoardProps } from "@q9labsai/chalk-whiteboard/react";
import { useCan, useConnection, useParticipants, useSelf, useWhiteboard } from "../../bindings/hooks";
import { Avatar } from "../atomic/Avatar";

export type BoardProps = Omit<SharedBoardProps, "isHost" | "connectionStatus" | "sceneId" | "sceneStatus" | "ownParticipantId" | "viewBounds" | "renderCursorAvatar" | "onExport" | "participantIds" | "whoCanDraw">;

const cursorAvatar = (name: string) => <Avatar name={name} size="xs" animated={false} className="chalk-board-cursor-avatar" />;

export function Board(props: BoardProps) {
  const isHost = useCan("manageWhiteboard");
  const connection = useConnection();
  const boardSession = useWhiteboard().engine;
  const self = useSelf();
  const { roster } = useParticipants();
  const participantIds = useMemo(() => roster.map((person) => person.participantId), [roster]);
  const whoCanDraw = useWhoCanDraw(useContext(BoardToastContext));
  return (
    <SharedBoard
      {...props}
      participantIds={participantIds}
      whoCanDraw={whoCanDraw}
      isHost={isHost}
      connectionStatus={connection.status}
      sceneId={boardSession.sceneId}
      sceneStatus={boardSession.status}
      ownParticipantId={self.participantId}
      viewBounds={ChalkWhiteboardViewBounds}
      renderCursorAvatar={cursorAvatar}
    />
  );
}
