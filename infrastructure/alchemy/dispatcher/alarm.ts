import { Alarm } from "@alchemy.run/aws/CloudWatch/Alarm";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { providers } from "../config.ts";

// Native Alarm.read includes evaluation state and timestamps in its attributes.
// A healthy alarm transition is not infrastructure drift and must not block a
// release. Keep every configuration field, dropping only computed observations.
export const configurationAlarm = (attr: Alarm["Attributes"]): Alarm["Attributes"] => {
  const { StateValue: _state, StateReason: _reason, StateReasonData: _reasonData, StateUpdatedTimestamp: _updated, StateTransitionedTimestamp: _transitioned, AlarmConfigurationUpdatedTimestamp: _configurationUpdated, ...metricAlarm } = attr.metricAlarm;
  const result = { ...attr, stateValue: undefined, stateReason: undefined, metricAlarm };
  return Unowned.is(attr) ? Unowned(result) : result;
};
export const alarmProvider = Provider.effect(
  Alarm,
  Effect.gen(function* () {
    const base = yield* Provider.findProvider(Alarm);
    const read = base.read;
    if (!read) return yield* Effect.die("Pinned CloudWatch Alarm provider has no read method");
    return { ...base, read: (input) => read(input).pipe(Effect.map((attr) => (attr ? configurationAlarm(attr) : undefined))), reconcile: (input) => base.reconcile(input).pipe(Effect.map(configurationAlarm)) } satisfies typeof base;
  }).pipe(Effect.provide(providers)),
);
