import { describe, expect, it } from "vitest";
import { drainQueue, splitBudget, type JobQueue } from "../src/queue.js";
import type { DispatcherContext, DispatcherDependencies, JourneyContext } from "../src/types.js";

const journey: JourneyContext = { journeyId: "journey" };
const dependencies = { config: { timeoutReserveMs: 1000 } } as DispatcherDependencies;

function queueOf(assignments: string[], outcomes: Record<string, "completed" | "failed">) {
  const released: string[] = [];
  const queue: JobQueue<string> = {
    logPrefix: "test",
    claim: async (limit) => assignments.slice(0, limit),
    process: async (assignment) => outcomes[assignment] ?? "completed",
    release: async (assignment) => void released.push(assignment),
  };
  return { queue, released };
}

describe("draining a job queue", () => {
  it("counts what each assignment ended as", async () => {
    const { queue } = queueOf(["a", "b", "c"], { b: "failed" });
    const context: DispatcherContext = { getRemainingTimeInMillis: () => 60_000 };
    expect(await drainQueue(queue, 5, journey, context, dependencies)).toEqual({ claimed: 3, completed: 2, failed: 1 });
  });

  it("claims nothing once only the timeout reserve is left", async () => {
    const { queue } = queueOf(["a"], {});
    const context: DispatcherContext = { getRemainingTimeInMillis: () => 500 };
    expect(await drainQueue(queue, 5, journey, context, dependencies)).toEqual({ claimed: 0, completed: 0, failed: 0 });
  });

  it("hands back the assignments it claimed but ran out of time for", async () => {
    const { queue, released } = queueOf(["a", "b"], {});
    let remaining = 60_000;
    const context: DispatcherContext = { getRemainingTimeInMillis: () => remaining };
    const slowQueue: JobQueue<string> = {
      ...queue,
      claim: async (limit) => {
        const claimed = await queue.claim(limit, journey);
        remaining = 500;
        return claimed;
      },
    };
    expect(await drainQueue(slowQueue, 2, journey, context, dependencies)).toEqual({ claimed: 2, completed: 0, failed: 2 });
    expect(released).toEqual(["a", "b"]);
  });
});

describe("splitting a claim budget across queues", () => {
  it("gives the first queue the remainder and never loses a claim", () => {
    expect(splitBudget(7, 3)).toEqual([3, 2, 2]);
    expect(splitBudget(1, 3)).toEqual([1, 0, 0]);
    expect(splitBudget(0, 3)).toEqual([0, 0, 0]);
  });
});
