import type { TelemetryOutbox } from "./outbox";
import type { TelemetryEvent } from "./types";

/** What the app reports about itself. Each report leaves at once, because a crash or a problem report is often followed by a closed tab. */
export type AppTelemetry = {
  /** Names this client in a problem report, so support can find its events. */
  readonly sessionId: string;
  readonly problemReported: () => void;
  readonly renderCrashed: (cause: NonNullable<TelemetryEvent["render_cause"]>, error?: unknown) => void;
  /** Records the crash fallback's `shown` when it has actually committed; the returned function records `dismissed`. */
  readonly crashFallbackShown: () => () => void;
};

const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "DOMException"]);

/** The caught object's name, classified without its message: a non-Error is other, a null error is none. */
export function errorName(error: unknown): "Error" | "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "DOMException" | "other" | "none" {
  if (error === null || error === undefined) return "none";
  const name = error instanceof Error ? error.name : "other";
  return ERROR_NAMES.has(name) ? (name as ReturnType<typeof errorName>) : "other";
}

const CHUNK_PATTERNS = [/failed to fetch dynamically imported module/i, /failed to load module script/i, /importing a module script failed/i, /loading chunk/i, /chunkloaderror/i];

/** Whether the object's message reads as a lazy chunk failing to load, classified here and never stored. */
export function errorClass(error: unknown): "chunk_load" | "other" {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return CHUNK_PATTERNS.some((pattern) => pattern.test(message)) ? "chunk_load" : "other";
}

/** First 12 hex of SHA-256 over the top 5 stack frames as file:line:col: a stable crash fingerprint with no message or stack text. */
export async function errorFingerprint(error: unknown): Promise<string | undefined> {
  if (!(error instanceof Error) || typeof error.stack !== "string" || typeof crypto?.subtle === "undefined") return undefined;
  const frames = error.stack
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /:\d+:\d+\)?$/.test(line))
    .slice(0, 5)
    .map((line) => {
      const match = /(\S+:\d+:\d+)/.exec(line);
      return match?.[1] ?? line;
    });
  if (frames.length === 0) return undefined;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(frames.join("\n")));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

export const appTelemetry = (outbox: TelemetryOutbox): AppTelemetry => ({
  sessionId: outbox.clientSessionId,
  problemReported: () => {
    outbox.record({ type: "problem_reported" });
    void outbox.flush();
  },
  renderCrashed: (cause, error) => {
    const send = (fingerprint?: string) => {
      outbox.obs.fact("client.render_crashed", {
        render_cause: cause,
        ...(error === undefined ? {} : { error_name: errorName(error), error_class: errorClass(error) }),
        ...(fingerprint === undefined ? {} : { error_fingerprint: fingerprint }),
      });
      void outbox.flush();
    };
    void errorFingerprint(error).then(send, () => send());
  },
  crashFallbackShown: () => {
    const handle = outbox.obs.surface("client.call_crashed", {});
    return () => handle.dismiss();
  },
});
