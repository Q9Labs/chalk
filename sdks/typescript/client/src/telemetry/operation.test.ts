import { describe, expect, it } from "vitest";
import { observeOperation } from "./operation";
import { createTestOutbox } from "./outbox.test.helpers";

const failure = () => ({ code: "command_rejected" as const });

async function results(run: () => Promise<unknown>, shortfall?: (result: unknown) => { readonly code: "command_rejected" } | undefined) {
  const test = createTestOutbox();
  try {
    await observeOperation(test.outbox, { action: "mute", source: "microphone" }, run, failure, shortfall);
  } catch {
    // The caller sees the failure unchanged; this test reads what the outbox got.
  }
  await test.outbox.flush();
  return test.accepted.filter((event) => event.type === "media_intent" || event.type === "media_result").map(({ type, outcome, code }) => ({ type, outcome, code }));
}

describe("observeOperation", () => {
  it("records the intent and a succeeded result", async () => {
    expect(await results(async () => "done")).toEqual([{ type: "media_intent" }, { type: "media_result", outcome: "succeeded" }]);
  });

  it("records a failed result when the promise rejects", async () => {
    expect(await results(async () => Promise.reject(new Error("no")))).toEqual([{ type: "media_intent" }, { type: "media_result", outcome: "failed", code: "command_rejected" }]);
  });

  it("records a failed result when the operation throws before it returns a promise", async () => {
    const throwing = (): Promise<unknown> => {
      throw new Error("too many in flight");
    };
    expect(await results(throwing)).toEqual([{ type: "media_intent" }, { type: "media_result", outcome: "failed", code: "command_rejected" }]);
  });

  it("records a failed result when the run resolves but the caller reports a shortfall", async () => {
    expect(
      await results(
        async () => [],
        () => ({ code: "command_rejected" }),
      ),
    ).toEqual([{ type: "media_intent" }, { type: "media_result", outcome: "failed", code: "command_rejected" }]);
  });
});
