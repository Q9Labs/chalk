import type * as AWS from "@alchemy.run/aws";
import type { PolicyDocument, PolicyStatement } from "@alchemy.run/aws/IAM/Policy";
import * as Redacted from "effect/Redacted";
import { buildEnvironment } from "./environment.ts";
import type { FunctionProps } from "../providers/aws-versioned-function.ts";
import type { DispatcherInputs } from "./config.ts";

const policy = (Statement: PolicyStatement[]): PolicyDocument => ({ Version: "2012-10-17", Statement });
const allow = (Sid: string, Action: string[], Resource: string[]): PolicyStatement => ({ Sid, Effect: "Allow", Action, Resource });
export const resourceProps = (input: DispatcherInputs, account: string, region: string) => {
  const functionArn = `arn:aws:lambda:${region}:${account}:function:${input.function_name}`;
  const queueArn = (suffix: string) => `arn:aws:sqs:${region}:${account}:${input.function_name}-${suffix}`;
  const roleArn = (suffix: string) => `arn:aws:iam::${account}:role/${input.function_name}-${suffix}`;
  const scheduleArn = `arn:aws:scheduler:${region}:${account}:schedule/${input.scheduler_group_name}/${input.scheduler_name}`;
  const logName = `/aws/lambda/${input.function_name}`;
  const secrets = [input.api_workload_auth_parameter_arn, ...(input.codeswitch_provider === "mai" ? [input.openrouter_token_parameter_arn] : []), ...(input.deepinfra_enabled ? [input.deepinfra_token_parameter_arn] : []), ...(input.cloudflare_enabled ? [input.cloudflare_token_parameter_arn] : [])];
  const tags = { chalk_environment: input.environment_name, chalk_component: "transcription-dispatcher" };
  const sourceAccount = input.environment_name === "nightly" ? { StringEquals: { "aws:SourceAccount": account } } : {};
  const executionPolicy = policy([
    allow("WriteOwnLogs", ["logs:CreateLogStream", "logs:PutLogEvents"], [`arn:aws:logs:${region}:${account}:log-group:${logName}:*`]),
    allow("ReadOnlyTranscriptionAndApiSecrets", ["ssm:GetParameter", "ssm:GetParameters"], secrets),
    allow("WriteOnlyAsyncFailureDestination", ["sqs:SendMessage"], [queueArn("async-failure")]),
    ...(input.ssm_kms_key_arns.length
      ? [{ ...allow("DecryptOnlyConfiguredSsmKeys", ["kms:Decrypt"], [...input.ssm_kms_key_arns]), Condition: { StringEquals: { "kms:ViaService": `ssm.${region}.amazonaws.com`, ...(input.environment_name === "nightly" ? { "kms:EncryptionContext:PARAMETER_ARN": secrets } : {}) } } }]
      : []),
  ]);
  const executionRole: AWS.IAM.Role["Props"] = {
    roleName: `${input.function_name}-execution`,
    tags,
    assumeRolePolicyDocument: policy([{ Sid: "LambdaAssumeRole", Effect: "Allow", Action: ["sts:AssumeRole"], Principal: { Service: ["lambda.amazonaws.com"] } }]),
    inlinePolicies: { [`${input.function_name}-least-privilege`]: executionPolicy },
  };
  const schedulerRole: AWS.IAM.Role["Props"] = {
    roleName: `${input.function_name}-scheduler`,
    assumeRolePolicyDocument: policy([
      {
        Sid: "SchedulerAssumeRole",
        Effect: "Allow",
        Action: ["sts:AssumeRole"],
        Principal: { Service: ["scheduler.amazonaws.com"] },
        ...(input.environment_name === "nightly" ? { Condition: { ...sourceAccount, ArnEquals: { "aws:SourceArn": `arn:aws:scheduler:${region}:${account}:schedule-group/${input.scheduler_group_name}` } } } : {}),
      },
    ]),
    inlinePolicies: { [`${input.function_name}-scheduler-target`]: policy([allow("InvokeDispatcherOnly", ["lambda:InvokeFunction"], [functionArn]), allow("WriteSchedulerDlqOnly", ["sqs:SendMessage"], [queueArn("scheduler-dlq")])]) },
  };
  const queue = (suffix: string, Sid: string, Service: string, sourceArn: string, conditions: boolean): AWS.SQS.QueueProps => ({
    queueName: `${input.function_name}-${suffix}`,
    messageRetentionPeriod: "14 days",
    maximumMessageSize: 262144,
    delay: "0 seconds",
    receiveMessageWaitTime: "0 seconds",
    visibilityTimeout: "30 seconds",
    fifo: false,
    ...(input.failure_queue_kms_key_arn ? { kmsMasterKeyId: input.failure_queue_kms_key_arn, kmsDataKeyReusePeriod: "5 minutes" } : {}),
    // OpenTofu's existing standard queues use SSE-SQS, not the provider's false default.
    sqsManagedSseEnabled: input.failure_queue_kms_key_arn === null,
    policy: JSON.stringify(policy([{ ...allow(Sid, ["sqs:SendMessage"], [queueArn(suffix)]), Principal: { Service: [Service] }, Condition: { ...(conditions ? sourceAccount : {}), ArnEquals: { "aws:SourceArn": sourceArn } } }])),
    tags: { ...tags, chalk_component: `transcription-dispatcher-${suffix}` },
  });
  const log: AWS.Logs.LogGroup["Props"] = { logGroupName: logName, retention: `${input.log_retention_days} days`, ...(input.log_kms_key_arn ? { kmsKeyId: input.log_kms_key_arn } : {}), tags: { ...tags, chalk_release_id: input.release_id } };
  const fn: FunctionProps = {
    functionName: input.function_name,
    description: `Track-aware transcription dispatcher (${input.release_id})`,
    role: roleArn("execution"),
    runtime: "nodejs22.x",
    handler: input.handler,
    architectures: ["arm64"],
    code: { bucket: input.artifact_s3_bucket, key: input.artifact_s3_key, version: input.artifact_s3_object_version, sha256: input.artifact_sha256_base64 },
    timeout: input.timeout_seconds,
    memorySize: input.memory_size,
    reservedConcurrency: input.reserved_concurrency,
    ephemeralStorageSize: input.ephemeral_storage_size,
    environment: Redacted.make(buildEnvironment(input)),
    tracingMode: "Active",
    eventInvokeConfig: { maximumEventAge: input.async_max_event_age_seconds, maximumRetryAttempts: input.async_maximum_retry_attempts, onFailure: queueArn("async-failure") },
    tags: { ...tags, chalk_release_id: input.release_id, chalk_release_manifest_digest: input.release_manifest_digest, chalk_config_digest: input.config_digest },
  };
  const schedule: AWS.Scheduler.ScheduleProps = {
    name: input.scheduler_name,
    groupName: input.scheduler_group_name,
    scheduleExpression: "rate(1 minute)",
    scheduleExpressionTimezone: "UTC",
    state: input.scheduler_state,
    flexibleTimeWindow: { Mode: "OFF" },
    target: { Arn: functionArn, RoleArn: roleArn("scheduler"), Input: input.scheduler_input_json, RetryPolicy: { MaximumEventAgeInSeconds: input.scheduler_max_event_age_seconds, MaximumRetryAttempts: input.scheduler_maximum_retry_attempts }, DeadLetterConfig: { Arn: queueArn("scheduler-dlq") } },
  };
  const schedulerPermission: AWS.Lambda.PermissionProps = { functionName: input.function_name, action: "lambda:InvokeFunction", principal: "scheduler.amazonaws.com", sourceArn: scheduleArn };
  const controlPermission: AWS.Lambda.PermissionProps | undefined =
    input.control_api_invoker_principal !== null && input.control_api_invoke_source_arn !== null ? { functionName: input.function_name, action: "lambda:InvokeFunction", principal: input.control_api_invoker_principal, sourceArn: input.control_api_invoke_source_arn } : undefined;
  const alarm = (suffix: string, AlarmDescription: string, Namespace: string, MetricName: string, dimension: string, value: string, Statistic: "Sum" | "Maximum" = "Sum"): AWS.CloudWatch.AlarmProps => ({
    name: `${input.function_name}-${suffix}`,
    AlarmDescription,
    Namespace,
    MetricName,
    Dimensions: [{ Name: dimension, Value: value }],
    Statistic,
    Period: 300,
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [...input.alarm_actions],
  });
  return {
    executionRole,
    schedulerRole,
    log,
    fn,
    schedule,
    schedulerPermission,
    controlPermission,
    asyncFailure: queue("async-failure", "LambdaFailureDestination", "lambda.amazonaws.com", functionArn, false),
    schedulerDlq: queue("scheduler-dlq", "SchedulerFailureDestination", "scheduler.amazonaws.com", scheduleArn, true),
    alarms: {
      Errors: alarm("errors", "Transcription dispatcher invocation errors.", "AWS/Lambda", "Errors", "FunctionName", input.function_name),
      Throttles: alarm("throttles", "Reserved-concurrency throttles on the transcription dispatcher.", "AWS/Lambda", "Throttles", "FunctionName", input.function_name),
      AsyncEventsDropped: alarm("async-events-dropped", "Lambda dropped asynchronous transcription wake-up events.", "AWS/Lambda", "AsyncEventsDropped", "FunctionName", input.function_name),
      AsyncFailureDepth: alarm("async-failure-depth", "Async transcription failure destination contains messages requiring reconciliation.", "AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", `${input.function_name}-async-failure`, "Maximum"),
      SchedulerTargetErrors: alarm("scheduler-target-errors", "EventBridge Scheduler could not invoke the transcription dispatcher.", "AWS/Scheduler", "TargetErrorCount", "ScheduleGroup", input.scheduler_group_name),
    },
    outputs: {
      dispatcher_inputs: Redacted.make(input),
      lambda_function_arn: functionArn,
      lambda_execution_role_arn: roleArn("execution"),
      required_egress_destinations: [
        "control-api",
        "presigned-object-storage",
        "ssm",
        "kms",
        "telemetry",
        ...(input.codeswitch_provider === "mai" ? ["openrouter.ai"] : []),
        ...(input.deepinfra_enabled ? ["api.deepinfra.com"] : []),
        ...(input.cloudflare_enabled ? ["api.cloudflare.com"] : []),
      ].sort(),
      control_api_invoke_policy_json: JSON.stringify(policy([allow("InvokeTranscriptionDispatcherOnly", ["lambda:InvokeFunction"], [functionArn])])),
      scheduler_arn: scheduleArn,
      async_failure_queue_arn: queueArn("async-failure"),
      scheduler_dlq_arn: queueArn("scheduler-dlq"),
      log_group_name: logName,
      artifact_identity: { bucket: input.artifact_s3_bucket, key: input.artifact_s3_key, version_id: input.artifact_s3_object_version, sha256: input.artifact_sha256, sha256_base64: input.artifact_sha256_base64 },
      release_identity: { environment: input.environment_name, release_id: input.release_id, release_manifest_digest: input.release_manifest_digest, config_digest: input.config_digest },
    },
  };
};
