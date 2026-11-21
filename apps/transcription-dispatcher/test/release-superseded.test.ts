import { describe, expect, it } from "vitest";
import { RecorderControlApiClient } from "../src/control-api.js";
import { ControlApiError, isReleaseSuperseded } from "../src/errors.js";
import { drainQueue, type JobQueue } from "../src/queue.js";
import type { DispatcherContext, DispatcherDependencies, JourneyContext } from "../src/types.js";

const journey: JourneyContext = { journeyId: "journey" };
const context: DispatcherContext = { getRemainingTimeInMillis: () => 60_000 };

function supersededResponse(): Response {
  return new Response(JSON.stringify({ error: { code: "workload.release_superseded", message: "Workload release was superseded" } }), { status: 409 });
}

function clientAnswering(response: Response): RecorderControlApiClient {
  return new RecorderControlApiClient({ baseUrl: "https://control.invalid", signer: () => ({}), fetch: async () => response });
}

describe("a release the control API has superseded", () => {
  it("is recognised from the error code the claim is refused with", async () => {
    const error = await clientAnswering(supersededResponse())
      .claim({ limit: 1, context: journey })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlApiError);
    expect(isReleaseSuperseded(error)).toBe(true);
  });

  it("is told apart from any other 409", async () => {
    const stale = new Response(JSON.stringify({ error: { code: "lease.stale", message: "Lease is stale or expired" } }), { status: 409 });
    const error = await clientAnswering(stale)
      .claim({ limit: 1, context: journey })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ControlApiError);
    expect(isReleaseSuperseded(error)).toBe(false);
  });

  it("does not wait for the body of a refusal that cannot be a drain", async () => {
    const openEnded = new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 503 });
    const outcome = await Promise.race([
      clientAnswering(openEnded)
        .claim({ limit: 1, context: journey })
        .catch((caught: unknown) => caught),
      new Promise((resolve) => setTimeout(() => resolve("stalled"), 500)),
    ]);
    expect(outcome).toBeInstanceOf(ControlApiError);
  });

  it("ends the drain quietly: no claim retry, no error, nothing processed", async () => {
    const events: string[] = [];
    let claims = 0;
    const queue: JobQueue<string> = {
      logPrefix: "test",
      claim: async (limit, claimJourney) => {
        claims += 1;
        return (await clientAnswering(supersededResponse()).claim({ limit, context: claimJourney })).assignments.map(String);
      },
      process: async () => "completed",
      release: async () => undefined,
    };
    const dependencies = { config: { timeoutReserveMs: 1000 }, logger: { info: (event: string) => void events.push(event), warn: (event: string) => void events.push(`warn:${event}`) } } as unknown as DispatcherDependencies;

    expect(await drainQueue(queue, 5, journey, context, dependencies)).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(claims).toBe(1);
    expect(events).toEqual(["test_release_superseded"]);
  });

  it("still raises every other claim failure", async () => {
    const queue: JobQueue<string> = {
      logPrefix: "test",
      claim: async () => {
        throw new ControlApiError("control API request failed", 401);
      },
      process: async () => "completed",
      release: async () => undefined,
    };
    const dependencies = { config: { timeoutReserveMs: 1000 } } as DispatcherDependencies;
    await expect(drainQueue(queue, 5, journey, context, dependencies)).rejects.toBeInstanceOf(ControlApiError);
  });
});
