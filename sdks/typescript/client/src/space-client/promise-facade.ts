import { Effect } from "effect";

type ControllerCommand = (...args: never[]) => unknown;
type PromiseRuntime<Services> = { readonly runPromise: (effect: Effect.Effect<unknown, unknown, Services>) => Promise<unknown> };

export type PromiseCommand<Command> = Command extends (...args: infer Arguments) => infer Result ? (Result extends Effect.Effect<infer Success, unknown, unknown> ? (...args: Arguments) => Promise<Success> : (...args: Arguments) => Result) : never;

export type PromiseController<Controller extends Record<string, ControllerCommand>> = {
  readonly [Key in keyof Controller]: PromiseCommand<Controller[Key]>;
};

export function toPromiseController<Services, Controller extends Record<string, ControllerCommand>>(runtime: PromiseRuntime<Services>, controller: Controller): PromiseController<Omit<Controller, "configure" | "dispose">> {
  const projected: Record<string, ControllerCommand> = {};
  for (const [name, command] of Object.entries(controller)) {
    if (name === "configure" || name === "dispose") continue;
    projected[name] = (...args) => {
      const result = command(...args);
      return Effect.isEffect(result) ? runtime.runPromise(result) : result;
    };
  }
  return projected as PromiseController<Omit<Controller, "configure" | "dispose">>;
}
