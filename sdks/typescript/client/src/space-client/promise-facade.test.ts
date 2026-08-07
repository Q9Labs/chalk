import { Effect } from "effect";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { SpaceClientError } from "./errors";
import { toPromiseController } from "./promise-facade";

const attachment = { attachmentId: "attachment-1" };

type StubController = {
  readonly send: (value: string) => Effect.Effect<string, Error>;
  readonly fail: () => Effect.Effect<never, Error>;
  readonly upload: (file: string) => Effect.Effect<typeof attachment, Error>;
  readonly url: (attachmentId: string) => string;
  readonly configure: (enabled: boolean) => void;
  readonly dispose: () => void;
};

describe("toPromiseController", () => {
  it("runs Effect commands and preserves their failures", async () => {
    const failure = new SpaceClientError({ code: "chat.payload_invalid", recoverable: false, message: "mapped failure" });
    const controller: StubController = {
      send: (value) => Effect.succeed(`sent:${value}`),
      fail: () => Effect.fail(failure),
      upload: (file) => Effect.succeed({ attachmentId: file }),
      url: (attachmentId) => `/attachments/${attachmentId}`,
      configure: () => undefined,
      dispose: () => undefined,
    };
    const runtime = { runPromise: vi.fn((effect: Effect.Effect<unknown, unknown>) => Effect.runPromise(effect)) };
    const projected = toPromiseController(runtime, controller);

    await expect(projected.send("hello")).resolves.toBe("sent:hello");
    await expect(projected.fail()).rejects.toBe(failure);
    expect(runtime.runPromise).toHaveBeenCalledTimes(2);
  });

  it("returns direct members synchronously and projects chat.files", async () => {
    const controller: StubController = {
      send: (value) => Effect.succeed(`sent:${value}`),
      fail: () => Effect.fail(new Error("failure")),
      upload: (file) => Effect.succeed({ attachmentId: file }),
      url: (attachmentId) => `/attachments/${attachmentId}`,
      configure: () => undefined,
      dispose: () => undefined,
    };
    const runtime = { runPromise: vi.fn((effect: Effect.Effect<unknown, unknown>) => Effect.runPromise(effect)) };
    const projected = toPromiseController(runtime, controller);
    const chat = { send: projected.send, files: { upload: projected.upload, url: projected.url } };

    expectTypeOf(chat.files.url).toEqualTypeOf<(attachmentId: string) => string>();
    expect(chat.files.url("attachment-1")).toBe("/attachments/attachment-1");
    expect(runtime.runPromise).not.toHaveBeenCalled();
    await expect(chat.files.upload("attachment-1")).resolves.toEqual(attachment);
    expect(runtime.runPromise).toHaveBeenCalledOnce();
  });

  it("omits lifecycle methods from the runtime and projected type", () => {
    const controller: StubController = {
      send: (value) => Effect.succeed(`sent:${value}`),
      fail: () => Effect.fail(new Error("failure")),
      upload: (file) => Effect.succeed({ attachmentId: file }),
      url: (attachmentId) => `/attachments/${attachmentId}`,
      configure: () => undefined,
      dispose: () => undefined,
    };
    const runtime = { runPromise: vi.fn((effect: Effect.Effect<unknown, unknown>) => Effect.runPromise(effect)) };
    const projected = toPromiseController(runtime, controller);

    expect(projected).not.toHaveProperty("configure");
    expect(projected).not.toHaveProperty("dispose");
    expectTypeOf<typeof projected>().not.toHaveProperty("configure");
    expectTypeOf<typeof projected>().not.toHaveProperty("dispose");
  });
});
