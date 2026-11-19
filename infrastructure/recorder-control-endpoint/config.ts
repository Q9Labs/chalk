import * as Schema from "effect/Schema";
import { loadInputs } from "../platform/inputs.ts";

export const loadConfig = () => loadInputs("recorder-control-endpoint", Schema.decodeUnknownSync(Schema.Struct({ instance_id: Schema.NonEmptyString }), { onExcessProperty: "error" }));
