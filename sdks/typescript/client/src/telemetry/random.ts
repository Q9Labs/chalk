import { Clock, Context, Effect, Layer, Random } from "effect";

type TelemetryRandom = {
  readonly nextIntUnsafe: () => number;
};

export type TelemetryEventSource = {
  readonly createUuid: () => string;
  readonly now: () => Date;
  readonly randomHex: (byteLength: number) => string;
};

export class TelemetryEventSourceService extends Context.Service<TelemetryEventSourceService, TelemetryEventSource>()("@chalk/telemetry/TelemetryEventSource") {}

/** Uses Effect's production Clock and Random services, while retaining the public `now` override. */
export const makeTelemetryEventSourceLayer = (now?: () => Date) =>
  Layer.effect(
    TelemetryEventSourceService,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      const random = yield* Random.Random;
      return {
        createUuid: () => createUuid(random),
        now: now ?? (() => new Date(clock.currentTimeMillisUnsafe())),
        randomHex: (byteLength) => randomHex(byteLength, random),
      };
    }),
  );

export function randomHex(byteLength: number, random: TelemetryRandom = Effect.runSync(Random.Random)): string {
  return Array.from(randomBytes(byteLength, random), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createUuid(random: TelemetryRandom = Effect.runSync(Random.Random)): string {
  const bytes = randomBytes(16, random);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function randomBytes(byteLength: number, random: TelemetryRandom): Uint8Array {
  const bytes = new Uint8Array(byteLength);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = random.nextIntUnsafe() & 0xff;

  return bytes;
}
