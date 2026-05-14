type RecordLike = Record<string, unknown>;

const STATE_FIELD_NAMES = new Set([
  "connectionState",
  "iceConnectionState",
  "iceGatheringState",
  "signalingState",
  "transportState",
  "socketState",
  "readyState",
  "state",
  "status",
  "joined",
  "isJoined",
  "roomJoined",
]);

const TRACK_FIELD_NAMES = new Set(["kind", "id", "label", "enabled", "muted", "readyState"]);

const asRecord = (value: unknown): RecordLike | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : null;

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const safeRead = (read: () => unknown): unknown => {
  try {
    return read();
  } catch (error) {
    return error instanceof Error ? `[read failed] ${error.message}` : "[read failed]";
  }
};

const readScalarField = (record: RecordLike | null, key: string) => {
  if (!record || !(key in record)) return undefined;
  const value = safeRead(() => record[key]);
  return isScalar(value) ? value : undefined;
};

const readScalarFields = (record: RecordLike | null, keys: readonly string[]) =>
  Object.fromEntries(
    keys.flatMap((key) => {
      const value = readScalarField(record, key);
      return value === undefined ? [] : [[key, value]];
    }),
  );

const summarizeTrack = (track: unknown) => {
  const record = asRecord(track);
  if (!record) return null;

  return Object.fromEntries(
    Object.entries(record)
      .filter(([key, value]) => TRACK_FIELD_NAMES.has(key) && isScalar(value))
      .slice(0, 8),
  );
};

const getCollectionSize = (value: unknown): number | null => {
  if (value instanceof Map || value instanceof Set) return value.size;
  if (Array.isArray(value)) return value.length;
  const record = asRecord(value);
  if (!record) return null;

  const size = safeRead(() => record.size);
  if (typeof size === "number") return size;

  const length = safeRead(() => record.length);
  if (typeof length === "number") return length;

  return null;
};

const getRecordAtPath = (root: RecordLike | null, path: readonly string[]) => {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record || !(key in record)) return null;
    current = safeRead(() => record[key]);
  }
  return asRecord(current);
};

const collectPublicStateFields = (root: RecordLike | null, rootPath: string, maxDepth = 3) => {
  const found: Array<{ path: string; value: string | number | boolean | null }> = [];
  const seen = new WeakSet<object>();

  const visit = (value: unknown, path: string, depth: number) => {
    if (found.length >= 24 || depth > maxDepth) return;
    const record = asRecord(value);
    if (!record || seen.has(record)) return;
    seen.add(record);

    for (const key of Object.keys(record)) {
      if (found.length >= 24) break;
      if (key.startsWith("_")) continue;

      const currentPath = `${path}.${key}`;
      const currentValue = safeRead(() => record[key]);
      if (isScalar(currentValue) && STATE_FIELD_NAMES.has(key)) {
        found.push({ path: currentPath, value: currentValue });
        continue;
      }

      if (depth < maxDepth && asRecord(currentValue)) {
        visit(currentValue, currentPath, depth + 1);
      }
    }
  };

  visit(root, rootPath, 0);
  return found;
};

export interface RealtimeKitDiagnosticsSnapshot {
  available: boolean;
  self: Record<string, unknown> | null;
  room: Record<string, unknown> | null;
  participants: Record<string, unknown> | null;
  media: Record<string, unknown> | null;
  transport: Record<string, unknown> | null;
  publicStateFields: Array<{ path: string; value: string | number | boolean | null }>;
  limitations: string[];
}

export const getRealtimeKitDiagnosticsSnapshot = (rtkClient: unknown): RealtimeKitDiagnosticsSnapshot => {
  const client = asRecord(rtkClient);
  if (!client) {
    return {
      available: false,
      self: null,
      room: null,
      participants: null,
      media: null,
      transport: null,
      publicStateFields: [],
      limitations: ["No active RTK client was available in the SDK session."],
    };
  }

  const self = getRecordAtPath(client, ["self"]);
  const room = getRecordAtPath(client, ["room"]) ?? getRecordAtPath(client, ["meeting"]);
  const participants = getRecordAtPath(client, ["participants"]);
  const transport =
    getRecordAtPath(client, ["transport"]) ??
    getRecordAtPath(client, ["connection"]) ??
    getRecordAtPath(client, ["peerConnection"]) ??
    getRecordAtPath(client, ["socket"]);
  const media = getRecordAtPath(client, ["media"]) ?? getRecordAtPath(client, ["tracks"]);

  const selfSummary = self
    ? {
        ...readScalarFields(self, [
          "id",
          "name",
          "userId",
          "participantId",
          "audioEnabled",
          "videoEnabled",
          "screenShareEnabled",
          "joined",
          "roomJoined",
          "connectionState",
        ]),
        audioTrack: summarizeTrack(safeRead(() => self.audioTrack)),
        videoTrack: summarizeTrack(safeRead(() => self.videoTrack)),
        screenShareTrack: summarizeTrack(safeRead(() => self.screenShareTrack)),
      }
    : null;

  const roomSummary = room
    ? readScalarFields(room, [
        "id",
        "name",
        "title",
        "joined",
        "isJoined",
        "roomJoined",
        "state",
        "status",
        "connectionState",
        "iceConnectionState",
        "iceGatheringState",
        "signalingState",
      ])
    : null;

  const participantsSummary = participants
    ? {
        size: getCollectionSize(participants),
        joinedSize: getCollectionSize(safeRead(() => participants.joined)),
        activeSize: getCollectionSize(safeRead(() => participants.active)),
      }
    : null;

  const mediaSummary = media
    ? {
        ...readScalarFields(media, [
          "state",
          "status",
          "connectionState",
          "iceConnectionState",
          "iceGatheringState",
          "signalingState",
        ]),
        audioTrack: summarizeTrack(safeRead(() => media.audioTrack)),
        videoTrack: summarizeTrack(safeRead(() => media.videoTrack)),
      }
    : null;

  const transportSummary = transport
    ? readScalarFields(transport, [
        "state",
        "status",
        "readyState",
        "connectionState",
        "iceConnectionState",
        "iceGatheringState",
        "signalingState",
        "transportState",
        "socketState",
      ])
    : null;

  return {
    available: true,
    self: selfSummary,
    room: roomSummary,
    participants: participantsSummary,
    media: mediaSummary,
    transport: transportSummary,
    publicStateFields: [
      ...collectPublicStateFields(self, "rtk.self"),
      ...collectPublicStateFields(room, "rtk.room"),
      ...collectPublicStateFields(transport, "rtk.transport"),
      ...collectPublicStateFields(media, "rtk.media"),
    ].slice(0, 32),
    limitations: [
      "RTK diagnostics only read public enumerable state exposed by the active client.",
      "ICE candidate pairs and WebRTC stats are not collected unless RTK exposes them synchronously on public fields.",
    ],
  };
};
