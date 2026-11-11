import type { ErrorCode } from "@q9labsai/chalk-client";

const MEDIA_FAILURE_DETAILS: Readonly<Partial<Record<ErrorCode, string>>> = {
  "connection.invalid_state": "Still connecting. Try again in a moment.",
  "media.timeout": "The call did not respond. Try again.",
};

export function mediaFailureMessage(permission: "microphone" | "camera", code: ErrorCode | null): string {
  return (code && MEDIA_FAILURE_DETAILS[code]) || `Couldn’t turn on your ${permission}. Try again.`;
}

const MAX_CAUSE_DEPTH = 4;
const MAX_STACK_LINES = 6;

/**
 * One line per error in the cause chain (name, SDK code, message), then the top of the innermost stack,
 * which names the call that threw. Failing to turn a device off has no retry or toast detail, so this is
 * the only place its cause is visible.
 */
export function describeMediaFailure(cause: unknown): string {
  const lines: string[] = [];
  let current: unknown = cause;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current !== undefined && current !== null; depth += 1) {
    if (!(current instanceof Error)) {
      lines.push(`  ${String(current)}`);
      break;
    }
    const code = "code" in current && typeof current.code === "string" ? ` [${current.code}]` : "";
    const tag = "_tag" in current && typeof current._tag === "string" ? current._tag : current.name;
    lines.push(`  ${tag}${code}: ${current.message}`);
    if (!(current.cause instanceof Error)) {
      if (current.stack) lines.push(...current.stack.split("\n").slice(1, 1 + MAX_STACK_LINES));
      if (current.cause !== undefined) lines.push(`  cause: ${String(current.cause)}`);
      break;
    }
    current = current.cause;
  }
  return lines.join("\n");
}
