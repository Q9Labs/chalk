import { expect, it, vi } from "vitest";
import { createCoreTestPlatform, opaqueAccessGrant } from "./core.test.helpers";
import { createSpaceClientForPlatform } from "./space-client";

it("rejects a second join during slow admission without requesting another admission", async () => {
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const getAccess = vi.fn(async () => {
    await pending;
    return opaqueAccessGrant(1);
  });
  const client = createSpaceClientForPlatform({ space: "test", getAccess }, createCoreTestPlatform());
  const first = client.join({ microphone: false, camera: false });
  let second: Promise<unknown> | undefined;
  try {
    await vi.waitFor(() => expect(getAccess).toHaveBeenCalledOnce());
    expect(client.getSnapshot().connection.status).toBe("joining");
    second = client.join({ microphone: false, camera: false }).catch((cause: unknown) => cause);
    const completed = vi.fn();
    void second.then(completed);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(await second).toMatchObject({ code: "invalid_state", recoverable: false, message: "Cannot configure Join while joining" });
    expect(getAccess).toHaveBeenCalledOnce();
    release();
    await first;
    expect(client.getSnapshot().connection.status).toBe("live");
    expect(getAccess).toHaveBeenCalledOnce();
  } finally {
    release();
    await Promise.allSettled([first, ...(second ? [second] : [])]);
    client.dispose();
  }
});
