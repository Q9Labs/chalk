/** The v1 diagnostic bundle: one gzip'd JSON object that an operator reads back from object storage. See `scripts/diagnose-call/r2.mjs`. */
const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const UTF8 = new TextEncoder();

/**
 * The `state` part is the only part a bundle always carries, and it holds named fields only — never free text.
 * `participant_id`, `episode_id` and `client_session_id` are what the readback checks against the API's record.
 */
export type DiagnosticBundleState = {
  readonly connection_status: string;
  readonly last_error_code?: string;
  readonly client_session_id: string;
  readonly participant_id: string;
  readonly episode_id: string;
  readonly app_version?: string;
  readonly sdk_version: string;
  readonly flags_hash?: string;
};

export type BundlePartStatus = { readonly status: "observed"; readonly bytes: number } | { readonly status: "unavailable"; readonly reason: "not_built" | "capture_failed" | "over_budget" };

export type DiagnosticBundleInput = {
  readonly state: DiagnosticBundleState;
  /** Optional collectors. Until the surface ring and flight recorder exist, callers pass nothing and the parts stay `unavailable(not_built)`. */
  readonly surfaceTree?: () => unknown | Promise<unknown>;
  readonly flightRecorder?: () => unknown | Promise<unknown>;
  /** Gzip for test or non-`CompressionStream` runtimes; defaults to `CompressionStream("gzip")`. */
  readonly deflate?: (bytes: Uint8Array) => Promise<Uint8Array>;
};

const gzipDefault = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new CompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes as BufferSource).then(() => writer.close());
  const compressed = await new Response(stream.readable).arrayBuffer();
  await written;
  return new Uint8Array(compressed);
};

type CapturedPart = { readonly status: "observed"; readonly bytes: number; readonly value: unknown } | { readonly status: "unavailable"; readonly reason: "not_built" | "capture_failed" | "over_budget" };

const capture = async (collector: (() => unknown | Promise<unknown>) | undefined): Promise<CapturedPart> => {
  if (!collector) return { status: "unavailable", reason: "not_built" };
  try {
    const value = await collector();
    const bytes = UTF8.encode(JSON.stringify(value ?? null)).byteLength;
    return { status: "observed", bytes, value };
  } catch {
    return { status: "unavailable", reason: "capture_failed" };
  }
};

const part = (captured: CapturedPart) => (captured.status === "observed" ? { status: "observed" as const, bytes: captured.bytes, value: captured.value } : { status: "unavailable" as const, reason: captured.reason });

/**
 * Builds `{diagnostic_bundle: 1, state, surface_tree, flight_recorder}`, gzipped, at or under the 4 MiB compressed budget.
 * An optional part that overflows the budget degrades to `unavailable(over_budget)` rather than failing the upload;
 * the `state` part is so small it can never overflow alone.
 */
export async function buildDiagnosticBundle(input: DiagnosticBundleInput): Promise<Uint8Array> {
  const deflate = input.deflate ?? gzipDefault;
  const state = { connection_status: input.state.connection_status, client_session_id: input.state.client_session_id, participant_id: input.state.participant_id, episode_id: input.state.episode_id, sdk_version: input.state.sdk_version };
  if (input.state.last_error_code) Object.assign(state, { last_error_code: input.state.last_error_code });
  if (input.state.app_version) Object.assign(state, { app_version: input.state.app_version });
  if (input.state.flags_hash) Object.assign(state, { flags_hash: input.state.flags_hash });
  const statePart = { status: "observed" as const, bytes: UTF8.encode(JSON.stringify(state)).byteLength, value: state };
  const parts = {
    surface_tree: await capture(input.surfaceTree),
    flight_recorder: await capture(input.flightRecorder),
  };
  const encode = () => UTF8.encode(JSON.stringify({ diagnostic_bundle: 1, state: statePart, surface_tree: part(parts.surface_tree), flight_recorder: part(parts.flight_recorder) }));
  let body = await deflate(encode());
  // Degrade optional parts rather than fail the upload when collectors hand back too much data.
  for (const name of ["surface_tree", "flight_recorder"] as const) {
    if (body.byteLength <= MAX_COMPRESSED_BYTES) break;
    if (parts[name].status === "observed") {
      parts[name] = { status: "unavailable", reason: "over_budget" };
      body = await deflate(encode());
    }
  }
  if (body.byteLength > MAX_COMPRESSED_BYTES) throw new Error(`diagnostic bundle is ${body.byteLength} bytes, over the ${MAX_COMPRESSED_BYTES}-byte budget`);
  return body;
}
