import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

// A refusal our own code wrote on purpose. Its message names a rule, never a value from a provider,
// so it is safe to show an operator. Every other failure stays hidden.
export class Refusal extends Data.TaggedError("Refusal")<{ readonly message: string }> {}

export const refuse = (message: string) => Effect.fail(new Refusal({ message }));
