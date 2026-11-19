import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import type { ConfiguredStack } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as lambda from "@distilled.cloud/aws/lambda";
import { VersionedFunction } from "../providers/aws-versioned-function.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { providers } from "../platform/config.ts";
import { refuse } from "../platform/refusal.ts";

function dispatcherPolicy(stack: ConfiguredStack<unknown, never>) {
  return Provider.effect(
    VersionedFunction,
    Effect.gen(function* () {
      const original = yield* Provider.findProvider(VersionedFunction);
      return {
        ...original,
        delete: Effect.fn(function* ({ output }: Parameters<typeof original.delete>[0]) {
          if ((yield* Stage) !== "nightly" || output.configuration.tags.chalk_environment !== "nightly") return yield* refuse("Retirement refuses a non-Nightly dispatcher function");
          yield* lambda.deleteFunction({ FunctionName: output.functionName }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
        }),
      };
    }).pipe(Effect.provide(stack.providers)),
  );
}
export function retirementStack(stack: ConfiguredStack<unknown, never>) {
  if (stack.stackName !== "transcription-dispatcher") return stack;
  return Alchemy.Stack(stack.stackName, { state: stack.state, providers: Layer.merge(stack.providers, dispatcherPolicy(stack).pipe(Layer.provide(providers))) }, Effect.void);
}
