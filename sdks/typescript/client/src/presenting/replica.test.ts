import { afterEach, expect, it, vi } from "vitest";
import { PresentingReplica } from "./replica";

const documentId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const presenterId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";
const documentState = { document_id: documentId, presenter_id: presenterId, page: 1, zoom: 100, started_at_ms: 10 };
const state = { revision: 1, documents: [documentState] };

function liveReplica() {
  const outbound: Record<string, unknown>[] = [];
  const replica = new PresentingReplica((wire) => {
    outbound.push(JSON.parse(wire));
    return true;
  });
  replica.enterLive(true);
  outbound.length = 0;
  return { replica, outbound };
}

afterEach(() => {
  vi.useRealTimers();
});

it("requests state on entry and applies state and change frames", () => {
  const outbound: unknown[] = [];
  const replica = new PresentingReplica((wire) => {
    outbound.push(JSON.parse(wire));
    return true;
  });
  replica.enterLive(true);
  expect(outbound).toMatchObject([{ type: "presenting_state_request" }]);
  expect(replica.getSnapshot()).toEqual({ status: "connecting" });

  replica.receive({ type: "presenting_state", state, server_at_ms: 1 });
  expect(replica.getSnapshot()).toMatchObject({ status: "ready", revision: 1, documents: [{ documentId, presenterId, page: 1, zoom: 100 }] });

  replica.receive({ type: "presenting_changed", state: { revision: 2, documents: [{ ...documentState, page: 3 }] }, server_at_ms: 2 });
  expect(replica.getSnapshot()).toMatchObject({ status: "ready", revision: 2, documents: [{ page: 3 }] });
});

it("resolves commands from their receipts and rejects nothing on accept", async () => {
  vi.useFakeTimers();
  const { replica, outbound } = liveReplica();
  replica.receive({ type: "presenting_state", state, server_at_ms: 1 });
  const pending = replica.setPage(documentId, 4);
  const frame = outbound.at(-1) as { type: string; operation_id: string; command: unknown };
  expect(frame.type).toBe("presenting_command");
  expect(frame.command).toEqual({ kind: "set_state", document_id: documentId, page: 4 });
  expect(frame.operation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

  replica.receive({ type: "presenting_receipt", operation_id: frame.operation_id, result: { kind: "accepted", revision: 2 } });
  await expect(pending).resolves.toEqual({ kind: "accepted", revision: 2 });
});

it("settles commands as delivery_unknown when the receipt never arrives", async () => {
  vi.useFakeTimers();
  const { replica } = liveReplica();
  const pending = replica.present(documentId);
  await vi.advanceTimersByTimeAsync(10_001);
  await expect(pending).resolves.toEqual({ kind: "delivery_unknown" });
});

it("refuses commands while the extension is unavailable and recovers with state", async () => {
  const { replica } = liveReplica();
  replica.receive({ type: "presenting_state", state: null, enabled: false, server_at_ms: 1 });
  expect(replica.getSnapshot()).toEqual({ status: "unavailable" });
  await expect(replica.present(documentId)).resolves.toEqual({ kind: "unavailable" });

  replica.enterLive(true);
  replica.receive({ type: "presenting_state", state, server_at_ms: 2 });
  expect(replica.getSnapshot()).toMatchObject({ status: "ready" });
});

it("discards pending commands on terminal disconnect", async () => {
  vi.useFakeTimers();
  const { replica } = liveReplica();
  const pending = replica.present(documentId);
  replica.disconnected(true);
  await expect(pending).resolves.toEqual({ kind: "delivery_unknown" });
  expect(replica.getSnapshot()).toEqual({ status: "unavailable" });
  expect(await replica.stop(documentId)).toEqual({ kind: "unavailable" });
});
