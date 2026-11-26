import type * as AWS from "@alchemy.run/aws";
import type { PolicyDocument, PolicyStatement } from "@alchemy.run/aws/IAM/Policy";
import * as Redacted from "effect/Redacted";
import { buildEnvironment } from "./environment.ts";
import type { FunctionProps } from "../providers/aws-versioned-function.ts";
import type { DocumentRendererInputs } from "./config.ts";

const policy = (Statement: PolicyStatement[]): PolicyDocument => ({ Version: "2012-10-17", Statement });
const allow = (Sid: string, Action: string[], Resource: string[]): PolicyStatement => ({ Sid, Effect: "Allow", Action, Resource });
export const resourceProps = (input: DocumentRendererInputs, account: string, region: string) => {
  const functionArn = `arn:aws:lambda:${region}:${account}:function:${input.function_name}`;
  const roleArn = (suffix: string) => `arn:aws:iam::${account}:role/${input.function_name}-${suffix}`;
  const logName = `/aws/lambda/${input.function_name}`;
  const tags = { chalk_environment: input.environment_name, chalk_component: "document-renderer" };
  const executionPolicy = policy([allow("WriteOwnLogs", ["logs:CreateLogStream", "logs:PutLogEvents"], [`arn:aws:logs:${region}:${account}:log-group:${logName}:*`])]);
  const executionRole: AWS.IAM.Role["Props"] = {
    roleName: `${input.function_name}-execution`,
    tags,
    assumeRolePolicyDocument: policy([{ Sid: "LambdaAssumeRole", Effect: "Allow", Action: ["sts:AssumeRole"], Principal: { Service: ["lambda.amazonaws.com"] } }]),
    inlinePolicies: { [`${input.function_name}-least-privilege`]: executionPolicy },
  };
  const log: AWS.Logs.LogGroup["Props"] = { logGroupName: logName, retention: `${input.log_retention_days} days`, ...(input.log_kms_key_arn ? { kmsKeyId: input.log_kms_key_arn } : {}), tags: { ...tags, chalk_release_id: input.release_id } };
  const fn: FunctionProps = {
    functionName: input.function_name,
    description: `Presenting document renderer (${input.release_id})`,
    role: roleArn("execution"),
    runtime: "provided.al2023",
    handler: "bootstrap",
    architectures: ["arm64"],
    code: { bucket: input.artifact_s3_bucket, key: input.artifact_s3_key, version: input.artifact_s3_object_version, sha256: input.artifact_sha256_base64 },
    timeout: input.timeout_seconds,
    memorySize: input.memory_size,
    reservedConcurrency: input.reserved_concurrency,
    ephemeralStorageSize: input.ephemeral_storage_size,
    environment: Redacted.make(buildEnvironment(input)),
    tracingMode: "Active",
    eventInvokeConfig: { maximumEventAge: input.async_max_event_age_seconds, maximumRetryAttempts: input.async_maximum_retry_attempts },
    tags: { ...tags, chalk_release_id: input.release_id, chalk_release_manifest_digest: input.release_manifest_digest, chalk_config_digest: input.config_digest },
  };
  const failureMetricName = `RenderInvocationFailures-${input.function_name}`;
  const failureLogMetric: AWS.Logs.MetricFilterProps = {
    logGroupName: logName,
    filterName: `${input.function_name}-invocation-failures`,
    filterPattern: '{ $.msg = "render invocation failed; recycling execution environment" }',
    metricTransformations: [{ metricName: failureMetricName, metricNamespace: "Chalk/DocumentRenderer", metricValue: "1" }],
  };
  const alarm = (suffix: string, AlarmDescription: string, Namespace: string, MetricName: string, withFunctionDimension = true): AWS.CloudWatch.AlarmProps => ({
    name: `${input.function_name}-${suffix}`,
    AlarmDescription,
    Namespace,
    MetricName,
    ...(withFunctionDimension ? { Dimensions: [{ Name: "FunctionName", Value: input.function_name }] } : {}),
    Statistic: "Sum",
    Period: 300,
    EvaluationPeriods: 1,
    Threshold: 1,
    ComparisonOperator: "GreaterThanOrEqualToThreshold",
    TreatMissingData: "notBreaching",
    AlarmActions: [...input.alarm_actions],
  });
  return {
    executionRole,
    log,
    fn,
    failureLogMetric,
    controlPermission: input.control_api_invoker_principal !== null && input.control_api_invoke_source_arn !== null ? { functionName: input.function_name, action: "lambda:InvokeFunction", principal: input.control_api_invoker_principal, sourceArn: input.control_api_invoke_source_arn } : undefined,
    alarms: {
      Errors: alarm("errors", "Document renderer reported a render invocation failure.", "Chalk/DocumentRenderer", failureMetricName, false),
      Throttles: alarm("throttles", "Reserved-concurrency throttles on the document renderer.", "AWS/Lambda", "Throttles"),
      AsyncEventsDropped: alarm("async-events-dropped", "Lambda dropped asynchronous renderer wake-up events.", "AWS/Lambda", "AsyncEventsDropped"),
    },
    outputs: {
      renderer_inputs: Redacted.make(input),
      lambda_function_arn: functionArn,
      lambda_execution_role_arn: roleArn("execution"),
      required_egress_destinations: ["control-api", "job-scoped-presigned-object-storage"].sort(),
      control_api_invoke_policy_json: JSON.stringify(policy([allow("InvokeDocumentRendererOnly", ["lambda:InvokeFunction"], [functionArn])])),
      log_group_name: logName,
      artifact_identity: { bucket: input.artifact_s3_bucket, key: input.artifact_s3_key, version: input.artifact_s3_object_version, sha256: input.artifact_sha256 },
      release_identity: { release_id: input.release_id, release_manifest_digest: input.release_manifest_digest, config_digest: input.config_digest },
    },
  };
};
