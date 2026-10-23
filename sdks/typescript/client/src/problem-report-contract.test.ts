import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CreateSpaceRequestSchema, ProblemReportRequestSchema, UpdateSpaceRequestSchema } from "./generated/schemas";

const decode = Schema.decodeUnknownSync(ProblemReportRequestSchema);
describe("problem report contract nonblank parity", () => {
  it.each(["", " ", "\t\n\r\v\f", "\u0085", "\u00a0\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000"])("rejects Go TrimSpace blank text %j", (description) => {
    expect(() => decode({ description })).toThrow();
  });
  it.each(["The camera froze", "\u0085 camera \u3000", "\ufeff", "🎥"])("accepts Go TrimSpace nonblank text %j", (description) => {
    expect(decode({ description }).description).toBe(description);
  });
});

describe("Space creation and report name bound", () => {
  const decoders = [Schema.decodeUnknownSync(CreateSpaceRequestSchema), Schema.decodeUnknownSync(UpdateSpaceRequestSchema)];
  it.each(["n", "🎥"])("keeps the 120-code-point name bound for %s", (character) => {
    for (const decodeName of decoders) {
      const valid = { name: character.repeat(120), slug: "test", media_plane: "cf_sfu", default_episode_duration_seconds: 3600, maximum_episode_duration_seconds: 3600, linger_window_seconds: 0 };
      expect(decodeName(valid).name).toBe(valid.name);
      expect(() => decodeName({ ...valid, name: character.repeat(121) })).toThrow();
    }
  });
});
