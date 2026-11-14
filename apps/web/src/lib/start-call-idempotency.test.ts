import { describe, expect, it } from "vitest";
import type { ChalkPublicClient } from "@q9labsai/chalk-client";
import { arriveAtSpace } from "../components/space/arrival";

const created = { arrival: {}, space: { slug: "s", name: "S" }, invite_link: "https://chalk.live/s" };

/** A Start call server that loses the answer to the first `lostAnswers` requests and records every request key it sees. */
function startCallServer(lostAnswers: number) {
  const requestKeys: string[] = [];
  const client = {
    create: async (_input: unknown, options: { idempotencyKey: string }) => {
      requestKeys.push(options.idempotencyKey);
      if (requestKeys.length <= lostAnswers) throw new Error("answer lost");
      return created;
    },
  } as unknown as ChalkPublicClient;
  return { client, requestKeys };
}
const press = (client: ChalkPublicClient, displayName: string) => arriveAtSpace(client, { displayName, slug: undefined, inviteToken: undefined }).catch(() => undefined);

describe("Start call", () => {
  it("sends one request key for a double press and for a retry after a failure", async () => {
    const { client, requestKeys } = startCallServer(2);
    await Promise.all([press(client, "Ada"), press(client, "Ada")]);
    await press(client, "Ada");
    expect(requestKeys).toHaveLength(3);
    expect(new Set(requestKeys).size).toBe(1);
  });

  it("sends a new request key for the next call after one started, and for another name", async () => {
    const { client, requestKeys } = startCallServer(0);
    await press(client, "Ada");
    await press(client, "Ada");
    await press(client, "Grace");
    expect(new Set(requestKeys).size).toBe(3);
  });
});
