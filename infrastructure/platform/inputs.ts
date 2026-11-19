import { readFile } from "node:fs/promises";
import * as Schema from "effect/Schema";

// Credentials never belong in this JSON. Each component owns its decoder.
export async function loadInputs<A>(component: string, parse: (value: unknown) => A): Promise<A> {
  const file = process.env.CHALK_INFRA_INPUTS;
  if (!file) throw new Error(`Set CHALK_INFRA_INPUTS to the private ${component} JSON input file (no credentials)`);
  try {
    return parse(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(await readFile(file, "utf8")));
  } catch {
    throw new Error(`Invalid or unreadable ${component} inputs from CHALK_INFRA_INPUTS; contents are not printed`);
  }
}
