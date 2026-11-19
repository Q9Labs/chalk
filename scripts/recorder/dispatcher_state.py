"""Read-only OpenTofu migration boundary; runtime releases never read legacy state."""
import base64
import json
import sys
from pathlib import Path
from release_core import require


def dispatcher_inputs_from_tofu(state):
    resources = {}
    for resource in state["resources"]:
        if resource.get("mode", "managed") == "managed":
            key = resource["type"] + "." + resource["name"]
            require(key not in resources, "ambiguous dispatcher resource: " + key)
            require(len(resource["instances"]) == 1, "ambiguous dispatcher instance")
            resources[key] = resource["instances"][0]["attributes"]
    function = resources["aws_lambda_function.dispatcher"]
    environment = function["environment"][0]["variables"]
    bindings = json.loads((Path(__file__).resolve().parents[2] / "infrastructure/alchemy/dispatcher/environment-bindings.json").read_text())
    inputs = {}
    for key, binding in bindings.items():
        if key not in environment:
            continue
        value = environment[key]
        if binding["type"] == "bool":
            require(value in ("true", "false"), "invalid dispatcher boolean")
            value = value == "true"
        elif binding["type"] == "number":
            value = int(value)
        inputs[binding["input"]] = value
    schedule = resources["aws_scheduler_schedule.reconcile"]
    target = schedule["target"][0]
    retry = target["retry_policy"][0]
    invoke = resources["aws_lambda_function_event_invoke_config.dispatcher"]
    inputs.update(function_name=function["function_name"], artifact_s3_bucket=function["s3_bucket"],
                  artifact_s3_key=function["s3_key"], artifact_s3_object_version=function["s3_object_version"],
                  artifact_sha256=base64.b64decode(function["source_code_hash"]).hex(),
                  artifact_sha256_base64=function["source_code_hash"], handler=function["handler"],
                  timeout_seconds=function["timeout"], memory_size=function["memory_size"],
                  ephemeral_storage_size=function["ephemeral_storage"][0]["size"],
                  reserved_concurrency=function["reserved_concurrent_executions"], scheduler_name=schedule["name"],
                  scheduler_group_name=schedule["group_name"], scheduler_state=schedule["state"], scheduler_input_json=target["input"],
                  scheduler_max_event_age_seconds=retry["maximum_event_age_in_seconds"],
                  scheduler_maximum_retry_attempts=retry["maximum_retry_attempts"],
                  async_max_event_age_seconds=invoke["maximum_event_age_in_seconds"],
                  async_maximum_retry_attempts=invoke["maximum_retry_attempts"],
                  log_retention_days=resources["aws_cloudwatch_log_group.dispatcher"]["retention_in_days"],
                  log_kms_key_arn=resources["aws_cloudwatch_log_group.dispatcher"]["kms_key_id"] or None,
                  failure_queue_kms_key_arn=resources["aws_sqs_queue.async_failure"]["kms_master_key_id"] or None,
                  alarm_actions=resources["aws_cloudwatch_metric_alarm.errors"]["alarm_actions"])
    policy = json.loads(resources["aws_iam_role_policy.dispatcher"]["policy"])
    inputs["ssm_kms_key_arns"] = sorted({arn for statement in policy["Statement"]
                                         for arn in ([statement["Resource"]] if isinstance(statement["Resource"], str) else statement["Resource"])
                                         if ":kms:" in arn})
    permission = resources.get("aws_lambda_permission.control_api")
    if permission:
        inputs["control_api_invoker_principal"] = permission["principal"]
        inputs["control_api_invoke_source_arn"] = permission["source_arn"]
    return inputs



def migration_props(state):
    """Explicit, fail-closed projection of every managed OpenTofu resource."""
    expected = {
        'aws_cloudwatch_log_group.dispatcher', 'aws_lambda_function.dispatcher',
        'aws_lambda_function_event_invoke_config.dispatcher', 'aws_iam_role.dispatcher', 'aws_iam_role.scheduler',
        'aws_iam_role_policy.dispatcher', 'aws_iam_role_policy.scheduler', 'aws_sqs_queue.async_failure',
        'aws_sqs_queue.scheduler_dlq', 'aws_sqs_queue_policy.async_failure', 'aws_sqs_queue_policy.scheduler_dlq',
        'aws_scheduler_schedule.reconcile', 'aws_lambda_permission.scheduler',
        *('aws_cloudwatch_metric_alarm.' + name for name in ('errors', 'throttles', 'async_events_dropped', 'async_failure_queue_depth', 'scheduler_target_errors')),
    }
    resources = {}
    for row in state['resources']:
        if row['mode'] != 'managed':
            continue
        address = row['type'] + '.' + row['name']
        require(row.get('module') == 'module.dispatcher', 'unexpected dispatcher module')
        require(address not in resources and len(row['instances']) == 1 and not row['instances'][0].get('deposed'), 'ambiguous dispatcher resource')
        resources[address] = row['instances'][0]['attributes']
    require(set(resources) in (expected, expected | {'aws_lambda_permission.control_api'}), 'unexpected managed dispatcher resources')
    def get(name):
        return resources[name]
    result = {}
    for name, logical in [('dispatcher', 'ExecutionRole'), ('scheduler', 'SchedulerRole')]:
        role = get('aws_iam_role.' + name)
        require(role['path'] == '/' and role['max_session_duration'] == 3600 and not role.get('permissions_boundary') and not role.get('managed_policy_arns'), 'unexpected IAM role configuration')
        inline = get('aws_iam_role_policy.' + name)
        require(inline['role'] == role['name'], 'inline policy role mismatch')
        result[logical] = dict(roleName=role['name'], assumeRolePolicyDocument=json.loads(role['assume_role_policy']), inlinePolicies={inline['name']: json.loads(inline['policy'])}, **({'tags': role['tags']} if role['tags'] else {}))
    for name, logical in [('async_failure', 'AsyncFailure'), ('scheduler_dlq', 'SchedulerDlq')]:
        q = get('aws_sqs_queue.' + name)
        require(not q['fifo_queue'] and q['delay_seconds'] == 0 and q['receive_wait_time_seconds'] == 0 and q['visibility_timeout_seconds'] == 30 and not q['redrive_policy'] and not q.get('redrive_allow_policy'), 'unexpected queue configuration')
        result[logical] = dict(queueName=q['name'], messageRetentionPeriod=str(q['message_retention_seconds'] // 86400) + ' days', maximumMessageSize=q['max_message_size'], delay='0 seconds', receiveMessageWaitTime='0 seconds', visibilityTimeout='30 seconds', fifo=False, sqsManagedSseEnabled=q['sqs_managed_sse_enabled'], policy=json.loads(get('aws_sqs_queue_policy.' + name)['policy']), tags=q['tags'])
        if q['kms_master_key_id']:
            require(q['kms_data_key_reuse_period_seconds'] == 300, 'unexpected queue KMS reuse interval')
            result[logical]['kmsMasterKeyId'] = q['kms_master_key_id']
            result[logical]['kmsDataKeyReusePeriod'] = '5 minutes'
    log = get('aws_cloudwatch_log_group.dispatcher')
    require(log.get('log_group_class', 'STANDARD') == 'STANDARD', 'unexpected log class')
    result['Logs'] = dict(logGroupName=log['name'], retention=str(log['retention_in_days']) + ' days', tags=log['tags'])
    if log['kms_key_id']:
        result['Logs']['kmsKeyId'] = log['kms_key_id']
    f = get('aws_lambda_function.dispatcher')
    require(not f.get('publish') and f['package_type'] == 'Zip' and not f.get('layers') and not f.get('file_system_config') and not f.get('dead_letter_config') and not f.get('kms_key_arn'), 'unexpected Lambda configuration')
    require(not any(v.get('subnet_ids') or v.get('security_group_ids') for v in f.get('vpc_config', [])), 'dispatcher must not have a VPC')
    invoke = get('aws_lambda_function_event_invoke_config.dispatcher')
    result['Function'] = dict(functionName=f['function_name'], description=f['description'], role=f['role'], runtime=f['runtime'], handler=f['handler'], architectures=f['architectures'], code=dict(bucket=f['s3_bucket'], key=f['s3_key'], version=f['s3_object_version'], sha256=f['source_code_hash']), timeout=f['timeout'], memorySize=f['memory_size'], reservedConcurrency=f['reserved_concurrent_executions'], ephemeralStorageSize=f['ephemeral_storage'][0]['size'], environment={'__redacted__': f['environment'][0]['variables']}, tracingMode=f['tracing_config'][0]['mode'], eventInvokeConfig=dict(maximumEventAge=invoke['maximum_event_age_in_seconds'], maximumRetryAttempts=invoke['maximum_retry_attempts'], onFailure=invoke['destination_config'][0]['on_failure'][0]['destination']), tags=f['tags'])
    s = get('aws_scheduler_schedule.reconcile')
    require(not s.get('kms_key_arn') and not s.get('start_date') and not s.get('end_date') and not s.get('description'), 'unexpected schedule configuration')
    target = s['target'][0]
    result['Reconcile'] = dict(name=s['name'], groupName=s['group_name'], scheduleExpression=s['schedule_expression'], scheduleExpressionTimezone=s['schedule_expression_timezone'], state=s['state'], flexibleTimeWindow={'Mode': s['flexible_time_window'][0]['mode']}, target=dict(Arn=target['arn'], RoleArn=target['role_arn'], Input=target['input'], RetryPolicy=dict(MaximumEventAgeInSeconds=target['retry_policy'][0]['maximum_event_age_in_seconds'], MaximumRetryAttempts=target['retry_policy'][0]['maximum_retry_attempts']), DeadLetterConfig={'Arn': target['dead_letter_config'][0]['arn']}))
    for name, logical in [('scheduler', 'SchedulerPermission'), ('control_api', 'ControlApiPermission')]:
        if 'aws_lambda_permission.' + name in resources:
            p = get('aws_lambda_permission.' + name)
            require(p['statement_id'] == ('AllowEventBridgeSchedulerWake' if name == 'scheduler' else 'AllowControlApiWake') and not p.get('qualifier') and not p.get('source_account') and not p.get('function_url_auth_type') and not p.get('event_source_token'), 'unexpected Lambda permission')
            result[logical] = dict(functionName=p['function_name'], action=p['action'], principal=p['principal'], sourceArn=p['source_arn'])
    for name, logical in [('errors', 'Errors'), ('throttles', 'Throttles'), ('async_events_dropped', 'AsyncEventsDropped'), ('async_failure_queue_depth', 'AsyncFailureDepth'), ('scheduler_target_errors', 'SchedulerTargetErrors')]:
        a = get('aws_cloudwatch_metric_alarm.' + name)
        require(a['actions_enabled'] and not a['ok_actions'] and not a['insufficient_data_actions'] and not a['metric_query'] and not a.get('tags') and not a.get('extended_statistic'), 'unexpected alarm configuration')
        result[logical] = dict(name=a['alarm_name'], **{new: a[old] for old, new in [('alarm_description','AlarmDescription'),('namespace','Namespace'),('metric_name','MetricName'),('statistic','Statistic'),('period','Period'),('evaluation_periods','EvaluationPeriods'),('threshold','Threshold'),('comparison_operator','ComparisonOperator'),('treat_missing_data','TreatMissingData'),('alarm_actions','AlarmActions')]}, Dimensions=[{'Name': k, 'Value': v} for k, v in a['dimensions'].items()])
    return result


def expected_live(state, props):
    resources = {r['type'] + '.' + r['name']: r['instances'][0]['attributes'] for r in state['resources'] if r['mode'] == 'managed'}
    live = {}
    for logical, name in [('ExecutionRole','dispatcher'), ('SchedulerRole','scheduler')]:
        p = props[logical]
        a = resources['aws_iam_role.' + name]
        live[logical] = dict(roleName=a['name'], roleArn=a['arn'], path='/', maxSessionDuration=3600, managedPolicyArns=[], inlinePolicies=p['inlinePolicies'], assumeRolePolicyDocument=p['assumeRolePolicyDocument'], tags=a['tags'])
    for logical, name in [('AsyncFailure','async_failure'), ('SchedulerDlq','scheduler_dlq')]:
        a = resources['aws_sqs_queue.' + name]
        live[logical] = dict(queueName=a['name'], queueUrl=a['url'], queueArn=a['arn'], tags=a['tags'], attributes=dict(MessageRetentionPeriod=str(a['message_retention_seconds']), MaximumMessageSize=str(a['max_message_size']), SqsManagedSseEnabled=str(a['sqs_managed_sse_enabled']).lower(), DelaySeconds='0', ReceiveMessageWaitTimeSeconds='0', VisibilityTimeout='30', Policy=props[logical]['policy']))
        if a['kms_master_key_id']:
            live[logical]['attributes']['KmsMasterKeyId'] = a['kms_master_key_id']
    a = resources['aws_cloudwatch_log_group.dispatcher']
    live['Logs'] = dict(logGroupName=a['name'], retentionInDays=a['retention_in_days'], logGroupClass='STANDARD', deletionProtectionEnabled=False, tags=a['tags'])
    if a['kms_key_id']:
        live['Logs']['kmsKeyId'] = a['kms_key_id']
    f = resources['aws_lambda_function.dispatcher']
    live['Function'] = dict(functionName=f['function_name'], functionArn=f['arn'], codeSha256=f['source_code_hash'], version=f['version'], configuration={k: v for k, v in props['Function'].items() if k != 'code'})
    p = props['Reconcile']
    live['Reconcile'] = dict(scheduleName=p['name'], groupName=p['groupName'], state=p['state'], configuration={k: v for k, v in p.items() if k not in ('name', 'groupName', 'state')})
    for logical, name in [('SchedulerPermission','scheduler'), ('ControlApiPermission','control_api')]:
        if logical in props:
            a = resources['aws_lambda_permission.' + name]
            live[logical] = dict(statementId=a['statement_id'], functionName=a['function_name'])
    for logical in ('Errors','Throttles','AsyncEventsDropped','AsyncFailureDepth','SchedulerTargetErrors'):
        p = props[logical]
        live[logical] = dict(alarmName=p['name'], tags={}, metricAlarm={**{k: v for k, v in p.items() if k != 'name'}, 'AlarmName': p['name']})
    return live


if __name__ == "__main__":
    state = json.loads(Path(sys.argv[1]).read_text())
    props = migration_props(state)
    print(json.dumps({'inputs': dispatcher_inputs_from_tofu(state), 'resources': props, 'live': expected_live(state, props)}))
