#!/usr/bin/env python3
"""Capture private, read-only dispatcher cutover facts. Never capture env values."""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/recorder'))
from transcription_dispatcher_state import dispatcher_inputs_from_tofu, migration_props
from release_io import Provider, private_json
from release_core import require


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tofu-state', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--compare', type=Path)
    args = parser.parse_args()
    state = json.loads(args.tofu_state.read_text())
    migration_props(state)
    inputs = dispatcher_inputs_from_tofu(state)
    provider = Provider('ap-southeast-1', os.environ.get('AWS_PROFILE', 'q9labs'))
    function = provider.aws('lambda', 'get-function-configuration', '--function-name', inputs['function_name'])
    schedule = provider.aws('scheduler', 'get-schedule', '--name', inputs['scheduler_name'], '--group-name', inputs['scheduler_group_name'])
    queues = {suffix: provider.aws('sqs', 'get-queue-url', '--queue-name', inputs['function_name'] + '-' + suffix)['QueueUrl'] for suffix in ('async-failure', 'scheduler-dlq')}
    expected = sorted(inputs['function_name'] + '-' + suffix for suffix in ('errors', 'throttles', 'async-events-dropped', 'async-failure-depth', 'scheduler-target-errors'))
    alarms = provider.aws('cloudwatch', 'describe-alarms', '--alarm-names', *expected)['MetricAlarms']
    names = sorted(item['AlarmName'] for item in alarms)
    require(names == expected, 'dispatcher alarms are missing')
    facts = dict(code_sha256=function['CodeSha256'], version=function['Version'], environment_names=sorted(function['Environment']['Variables']),
                 execution_role_arn=function['Role'], scheduler_role_arn=schedule['Target']['RoleArn'], queue_urls=queues, schedule_state=schedule['State'], alarm_names=names)
    private_json(args.output, facts)
    if args.compare:
        require(facts == json.loads(args.compare.read_text()), 'dispatcher moved during cutover; compare private evidence files')
    print(json.dumps({'facts_captured': True, 'unchanged': bool(args.compare), 'environment_name_count': len(facts['environment_names']), 'version': facts['version'], 'schedule_state': facts['schedule_state'], 'alarm_count': len(names)}))


if __name__ == '__main__':
    main()
