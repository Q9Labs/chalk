import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { R2Lifecycle, validateLifecycleRules } from "../alchemy/r2-lifecycle.ts";

export { r2LifecycleProvider } from "../alchemy/r2-lifecycle.ts";

export interface TranscriptionLifecycleProps {
  accountId: string;
  bucketName: string;
  temporaryPrefixes?: readonly string[];
  temporaryExpirationHours?: number;
  committedCleanupDeadlineHours?: number;
  finalizedTranscriptPrefix?: string;
}

export function transcriptionLifecycleConfig(props: TranscriptionLifecycleProps) {
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      accountId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{32}$/))),
      bucketName: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/))),
      temporaryPrefixes: Schema.Array(Schema.String),
      temporaryExpirationHours: Schema.Literal(24),
      committedCleanupDeadlineHours: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1))),
      finalizedTranscriptPrefix: Schema.String,
    }),
  )({ temporaryPrefixes: ["transcription/chunks/", "transcription/orphans/"], temporaryExpirationHours: 24, committedCleanupDeadlineHours: 1, finalizedTranscriptPrefix: "transcription/finalized/", ...props });
  const rules = config.temporaryPrefixes.map((prefix) => ({
    id: `expire-${prefix.replace(/^\/+|\/+$/g, "").replaceAll("/", "-")}`,
    enabled: true,
    conditions: { prefix },
    deleteObjectsTransition: { condition: { type: "Age" as const, maxAge: config.temporaryExpirationHours * 3600 } },
    abortMultipartUploadsTransition: { condition: { type: "Age" as const, maxAge: config.temporaryExpirationHours * 3600 } },
    storageClassTransitions: [],
  }));
  validateLifecycleRules(rules, config.finalizedTranscriptPrefix);
  return { ...config, rules };
}

export function transcriptionLifecycle(id: string, props: TranscriptionLifecycleProps) {
  const config = transcriptionLifecycleConfig(props);
  return R2Lifecycle(id, { accountId: config.accountId, bucketName: config.bucketName, rules: config.rules, finalizedPrefix: config.finalizedTranscriptPrefix }).pipe(
    // Preserve the module's outputs without putting the bucket under resource ownership.
    Effect.map(() => ({ bucket_name: config.bucketName, temporary_prefixes: config.temporaryPrefixes, temporary_expiration_hours: config.temporaryExpirationHours, committed_cleanup_deadline_hours: config.committedCleanupDeadlineHours })),
  );
}
