import { describe, expect, it } from "vitest";
import { ClockEstimator } from "./clock.ts";
import { flagsHash } from "./flags.ts";
import { ObsViolation, createKernel, expected, failure, type KernelMode, type ObsRecord } from "./kernel.ts";
import { SCHEMA_VER } from "./registry.ts";

function setup(mode: KernelMode = "closed", extra: { clock?: ClockEstimator; sink?: (record: ObsRecord) => void } = {}) {
  const records: ObsRecord[] = [];
  let next = 0;
  const kernel = createKernel({
    mode,
    sink: extra.sink ?? ((record) => records.push(record)),
    build: { module: "sdk", env: "test", platform: "web", sdk_version: "5.5.0" },
    sourceId: "cs-test",
    trail: () => ({ episode_id: "0f8fad5b-d9cb-469f-a165-70867728950e" }),
    uuid: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
    now: () => 1_800_000_000_000,
    ...(extra.clock ? { clock: extra.clock } : {}),
  });
  return { kernel, records };
}

describe("op", () => {
  it("records exactly one ok outcome with the envelope", async () => {
    const { kernel, records } = setup();
    await expect(kernel.op("selftest.work", { item_count: 2 }, () => "done")).resolves.toBe("done");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: "op",
      name: "selftest.work",
      outcome: "ok",
      item_count: 2,
      seq: 1,
      source_id: "cs-test",
      schema_ver: SCHEMA_VER,
      module: "sdk",
      env: "test",
      sdk_version: "5.5.0",
      episode_id: "0f8fad5b-d9cb-469f-a165-70867728950e",
      clock_state: "server",
      est_server_ms: 1_800_000_000_000,
    });
    expect(records[0]).not.toHaveProperty("reason_code");
  });

  it("ends as expected when the scope says so", async () => {
    const { kernel, records } = setup();
    await kernel.op("selftest.work", {}, (scope) => scope.expected("selftest.busy"));
    expect(records[0]).toMatchObject({ outcome: "expected", reason_code: "selftest.busy" });
  });

  it("records a classified throw and rethrows its cause", async () => {
    const { kernel, records } = setup();
    const cause = new Error("busy");
    await expect(
      kernel.op("selftest.work", {}, () => {
        throw expected("selftest.busy", cause);
      }),
    ).rejects.toBe(cause);
    expect(records[0]).toMatchObject({ outcome: "expected", reason_code: "selftest.busy" });
  });

  it("turns an unknown error into error(unclassified)", async () => {
    const { kernel, records } = setup();
    const cause = new TypeError("boom");
    await expect(kernel.op("selftest.work", {}, () => Promise.reject(cause))).rejects.toBe(cause);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: "error", reason_code: "unclassified" });
  });

  it("treats an abort as expected(cancelled) and lets the caller classify the rest", async () => {
    const { kernel, records } = setup();
    await expect(kernel.op("selftest.work", {}, () => Promise.reject(new DOMException("stop", "AbortError")))).rejects.toThrow("stop");
    await expect(kernel.op("selftest.work", {}, () => Promise.reject(new Error("db")), { classify: () => ({ outcome: "error", code: "selftest.broken" }) })).rejects.toThrow("db");
    await expect(kernel.op("selftest.work", {}, () => Promise.reject(failure("selftest.broken")))).rejects.toThrow("error(selftest.broken)");
    expect(records.map((record) => [record["outcome"], record["reason_code"]])).toEqual([
      ["expected", "cancelled"],
      ["error", "selftest.broken"],
      ["error", "selftest.broken"],
    ]);
  });

  it("tracks ops in flight and links a child to its parent", async () => {
    const { kernel, records } = setup();
    await kernel.op("selftest.work", {}, async (parent) => {
      expect(kernel.inFlight().map((op) => op.op_id)).toEqual([parent.opId]);
      await kernel.op("selftest.work", {}, () => undefined, { parentOpId: parent.opId, attempt: 2 });
    });
    expect(kernel.inFlight()).toEqual([]);
    expect(records[0]).toMatchObject({ parent_op_id: records[1]?.["op_id"], attempt: 2 });
  });
});

describe("the other four calls", () => {
  it("checks transitions against the machine table", () => {
    const { kernel, records } = setup();
    kernel.transition("selftest.door", "closed", "open", "push");
    expect(records[0]).toMatchObject({ kind: "transition", name: "selftest.door", machine: "selftest.door", from_state: "closed", to_state: "open", trigger: "push" });
    expect(() => kernel.transition("selftest.door", "open", "locked", "lock")).toThrow(ObsViolation);
  });

  it("returns a decision id and refuses an undeclared decision", () => {
    const { kernel, records } = setup();
    const id = kernel.decision("selftest.admit", "refused", {}, "selftest.busy");
    expect(records[0]).toMatchObject({ kind: "decision", decision: "refused", decision_id: id, reason_code: "selftest.busy" });
    // @ts-expect-error the generated types only allow declared decisions
    expect(() => kernel.decision("selftest.admit", "maybe", {})).toThrow("unknown decision maybe");
  });

  it("records a surface once when shown and once when dismissed", () => {
    const { kernel, records } = setup();
    const banner = kernel.surface("selftest.banner", { banner_kind: "warning" });
    banner.dismiss();
    banner.dismiss();
    expect(records.map((record) => record["surface_state"])).toEqual(["shown", "dismissed"]);
    expect(records[1]).toHaveProperty("shown_ms");
  });

  it("narrows enum values per event and requires required fields", () => {
    const { kernel } = setup();
    kernel.fact("selftest.note", { note_kind: "a" });
    // @ts-expect-error selftest.note only allows note_kind "a"
    expect(() => kernel.fact("selftest.note", { note_kind: "b" })).toThrow("not a valid enum");
    // @ts-expect-error note_kind is required
    expect(() => kernel.fact("selftest.note", {})).toThrow("required field note_kind is missing");
    // @ts-expect-error seq is stamped by the kernel
    expect(() => kernel.fact("selftest.note", { note_kind: "a", seq: 9 })).toThrow("not declared on this event");
  });

  it("rejects names that are not in the registry", () => {
    const { kernel } = setup();
    // @ts-expect-error unknown events don't type-check either
    expect(() => kernel.fact("made.up", {})).toThrow("unknown event made.up");
  });
});

describe("modes and the envelope", () => {
  it("counts violations in open mode and still emits the record", () => {
    const { kernel, records } = setup("open");
    kernel.transition("selftest.door", "open", "locked", "lock");
    expect(records).toHaveLength(1);
    expect(kernel.stats()).toMatchObject({ records: 1, violations: 1, exportFailures: 0 });
  });

  it("never throws for a failing sink in open mode", () => {
    const { kernel } = setup("open", {
      sink: () => {
        throw new Error("offline");
      },
    });
    kernel.fact("selftest.note", { note_kind: "a" });
    expect(kernel.stats().exportFailures).toBe(1);
  });

  it("logs the flags map and stamps its hash on later records", () => {
    const { kernel, records } = setup();
    const flags = { "media.kill_switch": false, max_participants: 50 };
    kernel.setFlags(flags);
    kernel.fact("selftest.note", { note_kind: "a" });
    expect(records[0]).toMatchObject({ name: "obs.flags_snapshot", flags, flags_hash: flagsHash(flags) });
    expect(records[1]).toMatchObject({ flags_hash: flagsHash(flags) });
  });

  it("stamps client clock fields and records a clock jump", () => {
    const clock = { mono: 1_000, wall: 1_700_000_000_000 };
    const estimator = new ClockEstimator({ mono: () => clock.mono, wall: () => clock.wall });
    const { kernel, records } = setup("closed", { clock: estimator });
    estimator.sample(900, 1_000, 1_800_000_000_000);
    kernel.fact("selftest.note", { note_kind: "a" });
    clock.wall += 10_000;
    kernel.fact("selftest.note", { note_kind: "a" });
    expect(records.map((record) => [record.name, record["clock_state"], record["clock_epoch"]])).toEqual([
      ["selftest.note", "synced", 0],
      ["obs.clock_jump", "unsynced", 1],
      ["selftest.note", "unsynced", 1],
    ]);
    expect(records[0]).toMatchObject({ est_server_ms: 1_800_000_000_050, clock_err_ms: 50 });
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3]);
  });
});
