import { describe, expect, it } from "vitest";
import { buildDiagnosticBundle, type DiagnosticBundleState } from "./bundle";

const state: DiagnosticBundleState = {
  connection_status: "live",
  last_error_code: "sync_connect_dial_1006",
  client_session_id: "cs_id",
  participant_id: "pt_id",
  episode_id: "ep_id",
  app_version: "1.2.3",
  sdk_version: "5.5.0",
  flags_hash: "abc123",
};

async function inflate(bytes: Uint8Array): Promise<Record<string, any>> {
  const stream = new DecompressionStream("gzip");
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes as BufferSource).then(() => writer.close());
  const plain = await new Response(stream.readable).arrayBuffer();
  await written;
  return JSON.parse(new TextDecoder().decode(plain));
}

describe("buildDiagnosticBundle", () => {
  it("writes the v1 envelope with the named state fields and not_built parts", async () => {
    const bundle = await inflate(await buildDiagnosticBundle({ state }));
    expect(bundle.diagnostic_bundle).toBe(1);
    expect(bundle.state).toMatchObject({ status: "observed", value: state });
    expect(bundle.surface_tree).toEqual({ status: "unavailable", reason: "not_built" });
    expect(bundle.flight_recorder).toEqual({ status: "unavailable", reason: "not_built" });
  });

  it("observes a collector's value with its byte size", async () => {
    const bundle = await inflate(await buildDiagnosticBundle({ state, surfaceTree: () => ({ root: { kind: "dialog" } }) }));
    expect(bundle.surface_tree.status).toBe("observed");
    expect(bundle.surface_tree.value).toEqual({ root: { kind: "dialog" } });
    expect(bundle.surface_tree.bytes).toBe(JSON.stringify({ root: { kind: "dialog" } }).length);
  });

  it("marks a throwing collector capture_failed without failing the bundle", async () => {
    const bundle = await inflate(
      await buildDiagnosticBundle({
        state,
        surfaceTree: () => {
          throw new Error("boom");
        },
        flightRecorder: () => {
          const cyclic: { self?: unknown } = {};
          cyclic.self = cyclic;
          return cyclic;
        },
      }),
    );
    expect(bundle.surface_tree).toEqual({ status: "unavailable", reason: "capture_failed" });
    expect(bundle.flight_recorder).toEqual({ status: "unavailable", reason: "capture_failed" });
    expect(bundle.state.status).toBe("observed");
  });

  it("degrades an oversized part to over_budget instead of failing", async () => {
    // A passthrough deflate keeps the body readable as JSON so the budget logic is what is exercised.
    const body = await buildDiagnosticBundle({ state, flightRecorder: () => "x".repeat(5 * 1024 * 1024), deflate: async (bytes) => bytes });
    const bundle = JSON.parse(new TextDecoder().decode(body));
    expect(bundle.flight_recorder).toEqual({ status: "unavailable", reason: "over_budget" });
    expect(bundle.state.status).toBe("observed");
  });

  it("drops undefined state fields so the part stays named-only", async () => {
    const { last_error_code: _e, app_version: _a, flags_hash: _f, ...rest } = state;
    const bundle = await inflate(await buildDiagnosticBundle({ state: rest }));
    expect(Object.keys(bundle.state.value).sort()).toEqual(["client_session_id", "connection_status", "episode_id", "participant_id", "sdk_version"]);
  });
});
