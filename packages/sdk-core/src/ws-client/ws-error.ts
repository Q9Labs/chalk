import type { ChalkError } from "../types.ts";

export const toWsError = (event: Event, ws: WebSocket | null): ChalkError => {
  const errorEvent = event as ErrorEvent;
  const errorMessage = errorEvent.message || "Unknown WebSocket error";
  const details: Record<string, unknown> = {
    message: errorMessage,
    type: event.type,
    readyState: ws?.readyState,
    readyStateDesc: ws ? ["CONNECTING", "OPEN", "CLOSING", "CLOSED"][ws.readyState] : "null",
  };

  if (errorEvent.filename) details.filename = errorEvent.filename;
  if (errorEvent.lineno) details.lineno = errorEvent.lineno;
  if (errorEvent.error) details.error = String(errorEvent.error);

  return {
    code: "WS_ERROR",
    message: `WebSocket error: ${errorMessage}`,
    details,
  };
};
