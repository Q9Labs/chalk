import { expect, it } from "vitest";
import { peerId, recordingClient, recoverSocket, recoveryId, settle, stateWithPeer, wireSnapshot } from "./v1-client-test-support";

it("keeps annotation off for old peers and retries an immutable command after negotiated recovery", async () => {
  const { client, clock, sockets } = recordingClient({ reconnectDelayMs: 1 });
  const initial = stateWithPeer("collaborator");
  const snapshot = await wireSnapshot(initial);
  const state = { ...initial, stateDigest: snapshot.state_digest };
  await client.start();
  sockets[0]!.open();
  await settle();
  await recoverSocket(client, sockets[0]!, state, snapshot, "snapshot");
  expect(client.annotation.getSnapshot()).toEqual({ status: "unavailable" });
  expect(sockets[0]!.frames().filter((frame) => String(frame.type).startsWith("annotation_"))).toEqual([]);

  const reconnect = async () => {
    sockets.at(-1)!.close();
    clock.advance(0);
    await settle();
    clock.advance(1);
    const socket = sockets.at(-1)!;
    socket.open();
    await settle();
    expect(socket.frames().some((frame) => frame.type === "annotation_state_request")).toBe(false);
    await recoverSocket(client, socket, state, snapshot, "up_to_date", true, undefined, false, false, true);
    expect(socket.frames().filter((frame) => frame.type === "annotation_state_request")).toEqual([{ type: "annotation_state_request" }]);
    return socket;
  };

  const first = await reconnect();
  const layer = { layer_id: recoveryId, publication_id: "observed-screen", sharer_id: peerId, frame: { width: 1920, height: 1080 } };
  const access = { draw_policy: "everyone", default_color: "#e55050", can_draw: true, can_moderate: false, can_manage_policy: false, requests: [] };
  const annotation = { layer, fence: 1, revision: 1, paused: false, access, marks: [] };
  first.receive({ type: "annotation_state", state: annotation, server_at_ms: Date.now() });
  await settle();
  const pending = client.annotation.dispatch({ layerId: layer.layer_id, fence: 1 }, { kind: "clear", scope: { kind: "mine" } });
  const wire = first.sent.at(-1);
  const submitted = first.frames().at(-1);
  expect(submitted).toMatchObject({ type: "annotation_command", fence: 1 });
  expect(submitted?.operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/);

  const second = await reconnect();
  expect(client.annotation.getSnapshot()).toEqual({ status: "connecting" });
  await expect(client.annotation.dispatch({ layerId: layer.layer_id, fence: 1 }, { kind: "undo" })).resolves.toEqual({ kind: "unavailable" });
  second.receive({ type: "annotation_state", state: { ...annotation, fence: 2, revision: 2 }, server_at_ms: Date.now() });
  await settle();
  expect(second.sent.at(-1)).toBe(wire);
  const result = { kind: "accepted", revision: 2, layer_id: layer.layer_id };
  second.receive({ type: "annotation_receipt", operation_id: submitted?.operation_id, result });
  await expect(pending).resolves.toEqual(result);
  await expect(client.annotation.dispatch({ layerId: layer.layer_id, fence: 1 }, { kind: "undo" })).resolves.toEqual({ kind: "rejected", reason: "stale_fence" });

  second.receive({ type: "annotation_changed", layer_id: layer.layer_id, fence: 2, revision: 4, server_at_ms: Date.now(), change: { kind: "clear", participant_id: null } });
  await settle();
  expect(client.annotation.getSnapshot()).toEqual({ status: "connecting" });
  expect(second.frames().at(-1)).toEqual({ type: "annotation_state_request" });
  client.stop();
});
