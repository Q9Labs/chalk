import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { expect, expectTypeOf, it } from "vitest";
import { toPromiseController, type PromiseCommand } from "./promise-facade";

it("preserves command arguments, success types, and synchronous results", async () => {
  const runtime = ManagedRuntime.make(Layer.empty);
  try {
    const controller = toPromiseController(runtime, {
      configure: () => {},
      dispose: () => {},
      greet: (name: string, times = 1) => Effect.succeed(name.repeat(times)),
      fail: () => Effect.fail(new Error("command failed")),
      count: (values: readonly number[]) => values.length,
      listen: (listener: (value: number) => void) => {
        listener(42);
        return () => "unsubscribed";
      },
    });

    expectTypeOf(controller.greet).toEqualTypeOf<(name: string, times?: number) => Promise<string>>();
    expectTypeOf(controller.fail).toEqualTypeOf<() => Promise<never>>();
    expectTypeOf(controller.count).toEqualTypeOf<(values: readonly number[]) => number>();
    expectTypeOf(controller.listen).toEqualTypeOf<(listener: (value: number) => void) => () => "unsubscribed">();
    expectTypeOf<keyof typeof controller>().toEqualTypeOf<"greet" | "fail" | "count" | "listen">();
    expectTypeOf<PromiseCommand<(value: boolean) => Effect.Effect<number, Error, { readonly service: "example" }>>>().toEqualTypeOf<(value: boolean) => Promise<number>>();

    expect(await controller.greet("hello", 2)).toBe("hellohello");
    await expect(controller.fail()).rejects.toThrow("command failed");
    expect(controller.count([1, 2, 3])).toBe(3);
    const values: number[] = [];
    expect(controller.listen((value) => values.push(value))()).toBe("unsubscribed");
    expect(values).toEqual([42]);
    expect(controller).not.toHaveProperty("configure");
    expect(controller).not.toHaveProperty("dispose");
  } finally {
    await runtime.dispose();
  }
});

it("runs commands with services supplied by their owning runtime", async () => {
  class Greeting extends Context.Service<Greeting, { readonly prefix: string }>()("Greeting") {}
  const runtime = ManagedRuntime.make(Layer.succeed(Greeting, { prefix: "Hello " }));
  try {
    const controller = toPromiseController(runtime, {
      greet: (name: string) => Effect.map(Greeting, ({ prefix }) => prefix + name),
    });
    expectTypeOf(controller.greet).toEqualTypeOf<(name: string) => Promise<string>>();
    expect(await controller.greet("Chalk")).toBe("Hello Chalk");
  } finally {
    await runtime.dispose();
  }
});
