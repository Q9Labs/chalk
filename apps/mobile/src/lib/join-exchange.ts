import { humanizeRoomName } from "@q9labs/chalk-core";

type JoinExchangePayload = {
  roomId?: string | null;
  roomName?: string | null;
};

export function getCanonicalJoinRoomId(payload: JoinExchangePayload): string {
  const roomId = payload.roomId?.trim();
  if (!roomId) {
    throw new Error("Invite link exchange missing canonical room id");
  }

  return roomId;
}

export function getJoinRoomName(payload: JoinExchangePayload): string {
  const roomId = getCanonicalJoinRoomId(payload);
  return humanizeRoomName(payload.roomName?.trim() || roomId);
}
