import { describe, expect, it, vi } from "vitest";
import type { ConnectionMediaFactoryInput } from "./dependencies";
import { createSpaceClientForPlatform } from "../space-client/space-client";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import { joinWithTerminalControl, terminalTestPlatform } from "../space-client/terminal.test.helpers";

describe("media connection replacement during Leave", () => {
  it("refreshes access for a replacement while connected but not once Leave has started", async () => {
    const platform = terminalTestPlatform();
    let replaceMediaConnection: ConnectionMediaFactoryInput["replaceMediaConnection"];
    const createMediaClient = platform.dependencies.createMediaClient;
    platform.dependencies.createMediaClient = (input) => {
      replaceMediaConnection = input.replaceMediaConnection;
      return createMediaClient(input);
    };
    let grants = 0;
    const getAccess = vi.fn(async () => {
      grants += 1;
      return opaqueAccessGrant(grants, String(grants), `connection-${grants}`);
    });
    const client = createSpaceClientForPlatform({ space: "test", getAccess }, platform);
    const leaveAck = Promise.withResolvers<Awaited<ReturnType<typeof platform.leave>>>();
    platform.leave.mockReturnValue(leaveAck.promise);
    try {
      await joinWithTerminalControl(client, platform);
      if (!replaceMediaConnection) throw new Error("The media client was not created with a replacement callback");

      const joinedCalls = getAccess.mock.calls.length;
      await replaceMediaConnection();
      expect(getAccess).toHaveBeenCalledTimes(joinedCalls + 1);

      const leaving = client.leave();
      await vi.waitFor(() => expect(client.getSnapshot().connection.status).toBe("leaving"));
      await expect(replaceMediaConnection()).rejects.toMatchObject({ code: "invalid_state" });
      expect(getAccess).toHaveBeenCalledTimes(joinedCalls + 1);

      leaveAck.resolve({ type: "ack", command_id: "leave", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" });
      await leaving;
      await expect(replaceMediaConnection()).rejects.toMatchObject({ code: "invalid_state" });
      expect(getAccess).toHaveBeenCalledTimes(joinedCalls + 1);
    } finally {
      leaveAck.resolve({ type: "ack", command_id: "leave", delivery: "original", outcome: "satisfied", revision: 2, state_digest: "digest" });
      client.dispose();
    }
  });
});
