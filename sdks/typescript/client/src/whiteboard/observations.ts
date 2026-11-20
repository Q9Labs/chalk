import { ClockEstimator } from "../obs/clock";
import { createKernel, type KernelMode } from "../obs/kernel";
import type { TelemetryDraft } from "../telemetry/types";

const telemetryTypes = {
  "board.client_edit": "board_edit",
  "board.client_delivery": "board_delivery",
  "board.client_draw": "board_draw",
  "board.client_snapshot": "board_snapshot",
  "board.follow": "board_follow",
} as const;

type WhiteboardTelemetry = {
  readonly sessionId: string;
  readonly record: (draft: TelemetryDraft) => void;
};

/** The existing outbox owns the client stream and assigns the wire event ID and sequence. */
export function createWhiteboardObservations(telemetry: WhiteboardTelemetry, options: { readonly clock?: ClockEstimator; readonly mode?: KernelMode } = {}) {
  const clock = options.clock ?? new ClockEstimator({ mono: () => performance.now(), wall: Date.now });
  return createKernel({
    sourceId: telemetry.sessionId,
    mode: options.mode ?? "open",
    build: { module: "sdk", env: "local" },
    clock,
    sink(record) {
      if (!Object.hasOwn(telemetryTypes, record.name)) return;
      const type = telemetryTypes[record.name as keyof typeof telemetryTypes];
      // The legacy wire is closed. Send only board metadata and a measured clock estimate, never the full record.
      const fields = Object.fromEntries(Object.entries(record).filter(([name]) => name.startsWith("board_") || name === "est_server_ms" || name === "clock_err_ms"));
      telemetry.record({ type, ...fields });
    },
  });
}
