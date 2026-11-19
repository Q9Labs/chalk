import assert from "node:assert/strict";
import { test } from "node:test";
import type { Alarm } from "@alchemy.run/aws/CloudWatch/Alarm";
import { configurationAlarm } from "./aws-dispatcher-alarm.ts";

test("normal alarm evaluation changes are not configuration drift; threshold changes remain observable", () => {
  const initial: Alarm["Attributes"] = {
    alarmName: "test",
    alarmArn: "arn:aws:cloudwatch:test:account:alarm:test",
    stateValue: "OK",
    stateReason: "Below threshold",
    tags: {},
    metricAlarm: { AlarmName: "test", Threshold: 1, StateValue: "OK", StateReason: "Below threshold", StateReasonData: "old evaluation", StateUpdatedTimestamp: new Date(0), AlarmConfigurationUpdatedTimestamp: new Date(0) },
  };
  const evaluated: Alarm["Attributes"] = {
    ...initial,
    stateValue: "ALARM",
    stateReason: "Threshold reached",
    metricAlarm: { ...initial.metricAlarm, StateValue: "ALARM", StateReason: "Threshold reached", StateReasonData: "new evaluation", StateUpdatedTimestamp: new Date(1000), StateTransitionedTimestamp: new Date(1000), AlarmConfigurationUpdatedTimestamp: new Date(1000) },
  };
  assert.deepEqual(configurationAlarm(initial), configurationAlarm(evaluated));
  assert.notDeepEqual(configurationAlarm(initial), configurationAlarm({ ...evaluated, metricAlarm: { ...evaluated.metricAlarm, Threshold: 2 } }));
});
