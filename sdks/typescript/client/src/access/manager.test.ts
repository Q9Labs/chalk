import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { opaqueAccessGrant } from "../space-client/core.test.helpers";
import type { ConnectionAccessRequest } from "../connection/dependencies";
import { parseParsedAccessGrant } from "./grant";
import { ConnectionAccessService, makeConnectionAccessLayer } from "./manager";

describe("media replacement", () => {
  async function accessWithGatedReplacement() {
    const requests: ConnectionAccessRequest[] = [];
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const provider = (request: ConnectionAccessRequest) =>
      Effect.promise(async () => {
        requests.push(request);
        const grant = requests.length;
        if (grant === 2) {
          entered.resolve();
          await release.promise;
        }
        return parseParsedAccessGrant(opaqueAccessGrant(grant, `g${grant}`, `connection-${grant}`));
      });
    const access = await Effect.runPromise(Effect.service(ConnectionAccessService).pipe(Effect.provide(makeConnectionAccessLayer(provider))));
    await Effect.runPromise(access.initialize("join"));
    return { access, requests, entered: entered.promise, release: release.resolve };
  }

  it("lets a second caller that saw the same dead binding use the binding the first one created", async () => {
    const { access, requests, entered, release } = await accessWithGatedReplacement();
    const first = Effect.runPromise(access.replaceMedia());
    await entered;
    const second = Effect.runPromise(access.replaceMedia());
    release();

    const [created, joined] = await Promise.all([first, second]);

    expect(created.created).toBe(true);
    expect(joined.created).toBe(false);
    expect(joined.access.media.clientPayload.connectionId).toBe("connection-2");
    expect(requests).toHaveLength(2);
  });

  it("replaces again when a caller sees a binding that is dead after the first replacement", async () => {
    const { access, requests, entered, release } = await accessWithGatedReplacement();
    const first = Effect.runPromise(access.replaceMedia());
    await entered;
    release();
    await first;

    const again = await Effect.runPromise(access.replaceMedia());

    expect(again.created).toBe(true);
    expect(again.access.media.clientPayload.connectionId).toBe("connection-3");
    expect(requests[2]?.expectedMediaConnectionId).toBe("connection-2");
  });
});
