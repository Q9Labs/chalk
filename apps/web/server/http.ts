export class DashboardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" } });
}
export function redirect(url: string): Response {
  return new Response(null, { status: 303, headers: { Location: url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
export function exactOrigin(request: Request, origin: string): void {
  if (new URL(request.url).origin !== origin || request.headers.get("Origin") !== origin) throw new DashboardError(403, "origin_rejected");
}
export async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new DashboardError(415, "json_required");
  if (!request.body) throw new DashboardError(400, "invalid_json");
  const reader = request.body.getReader();
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) {
        await reader.cancel();
        throw new DashboardError(413, "body_too_large");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DashboardError(400, "invalid_json");
  }
}
