import type { CallEvent, IncomingMediaRequest } from "@q9labsai/chalk-client";

/** A call event worth a notice on a phone. */
export type Notice =
  | { readonly kind: "joined"; readonly name: string }
  | { readonly kind: "left"; readonly name: string }
  | { readonly kind: "mutedByHost"; readonly by: string | null }
  | { readonly kind: "mediaRequest"; readonly request: IncomingMediaRequest }
  | { readonly kind: "newHost"; readonly previousHost: string }
  | { readonly kind: "shareStopped"; readonly name: string }
  | { readonly kind: "recordingStarted" }
  | { readonly kind: "recordingStopped" }
  | { readonly kind: "recordingFailed"; readonly failureCode: string | null };

/** The notice a call event gets on a phone, or null when the phone says nothing for it. */
export function callEventNotice(event: CallEvent): Notice | null {
  switch (event.kind) {
    case "joined":
      return { kind: "joined", name: event.participant.displayName };
    case "left":
      return { kind: "left", name: event.participant.displayName };
    case "shareStopped":
      return { kind: "shareStopped", name: firstName(event.participant.displayName) };
    case "hostChanged":
      return event.previousHost ? { kind: "newHost", previousHost: firstName(event.previousHost.displayName) } : null;
    case "mutedByHost":
      return { kind: "mutedByHost", by: event.by ? firstName(event.by.displayName) : null };
    case "mediaRequest":
      return { kind: "mediaRequest", request: event.request };
    case "recordingStarted":
    case "recordingStopped":
      return { kind: event.kind };
    case "recordingFailed":
      return { kind: "recordingFailed", failureCode: event.failureCode };
    case "handRaised":
    case "deviceSwitched":
      return null;
  }
}

/** The mockup names people by their first name in notices that ask something of you. */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}
