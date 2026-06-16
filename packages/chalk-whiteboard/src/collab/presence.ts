import type { Collaborator, ExcalidrawImperativeAPI, SocketId } from "./types.js";

const CURSOR_COLORS = [
  { stroke: "#FF5D5D", background: "rgba(255, 93, 93, 0.2)" },
  { stroke: "#4CB9FF", background: "rgba(76, 185, 255, 0.2)" },
  { stroke: "#8B5CF6", background: "rgba(139, 92, 246, 0.2)" },
  { stroke: "#10B981", background: "rgba(16, 185, 129, 0.2)" },
  { stroke: "#F59E0B", background: "rgba(245, 158, 11, 0.2)" },
  { stroke: "#EC4899", background: "rgba(236, 72, 153, 0.2)" },
  { stroke: "#22D3EE", background: "rgba(34, 211, 238, 0.2)" },
  { stroke: "#A3E635", background: "rgba(163, 230, 53, 0.2)" },
];

const getCursorColor = (id: string) => {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash << 5) - hash + id.charCodeAt(i);
    hash |= 0;
  }
  const index = Math.abs(hash) % CURSOR_COLORS.length;
  return CURSOR_COLORS[index]!;
};

const toSocketId = (value: string): SocketId => value as SocketId;

export class WhiteboardPresence {
  private lastCursorSend = 0;
  private collaborators = new Map<string, Collaborator & { _ts: number }>();
  private pruneInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly opts: {
      excalidrawAPI: ExcalidrawImperativeAPI;
      sendCursor: (payload: { x: number; y: number }) => void;
      throttleMs: number;
      staleMs: number;
    },
  ) {
    this.pruneInterval = setInterval(() => this.pruneStale(), 1000);
  }

  dispose(): void {
    if (this.pruneInterval) clearInterval(this.pruneInterval);
    this.pruneInterval = null;
    this.collaborators.clear();
  }

  handlePointerUpdate(payload: { pointer: { x: number; y: number } }): void {
    const now = Date.now();
    if (now - this.lastCursorSend < this.opts.throttleMs) return;
    this.lastCursorSend = now;
    this.opts.sendCursor(payload.pointer);
  }

  handleRemoteCursor(payload: { participantId: string; displayName: string; x: number; y: number; timestamp: Date }): void {
    const ts = payload.timestamp instanceof Date ? payload.timestamp.getTime() : Date.now();

    this.collaborators.set(payload.participantId, {
      pointer: { x: payload.x, y: payload.y, tool: "pointer", renderCursor: true },
      username: payload.displayName,
      color: getCursorColor(payload.participantId),
      id: payload.participantId,
      socketId: toSocketId(payload.participantId),
      _ts: ts,
    });

    this.apply();
  }

  private pruneStale() {
    const now = Date.now();
    let changed = false;
    for (const [id, c] of this.collaborators) {
      if (now - c._ts > this.opts.staleMs) {
        this.collaborators.delete(id);
        changed = true;
      }
    }
    if (changed) this.apply();
  }

  private apply() {
    const map = new Map<SocketId, Collaborator>();
    for (const [id, c] of this.collaborators) {
      const { _ts, ...rest } = c;
      map.set(toSocketId(id), rest);
    }
    this.opts.excalidrawAPI.updateScene({ collaborators: map });
  }
}
