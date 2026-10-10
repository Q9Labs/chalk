WITH failures AS (
  SELECT CASE jobs.kind WHEN 'capture' THEN 'recording' ELSE 'export' END AS rule,
    jobs.tenant_id, jobs.recording_id::text AS item,
    CASE WHEN jobs.kind = 'render' THEN pipelines.capture_completed_at +
      recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'
    END AS expires_at
  FROM recording_jobs jobs
  LEFT JOIN recording_pipelines pipelines ON pipelines.recording_id = jobs.recording_id
  LEFT JOIN episodes ON episodes.id = jobs.episode_id
  WHERE (jobs.kind = 'capture' AND jobs.state = 'terminal_failure'
      AND jobs.terminal_at >= now() - interval '15 minutes')
    OR (jobs.kind = 'render' AND (
      (jobs.state = 'terminal_failure' AND jobs.terminal_at >= now() - interval '15 minutes')
      OR (jobs.state IN ('pending', 'leased', 'retryable_failure')
        AND jobs.created_at < now() - interval '14 hours')))
  UNION ALL
  SELECT 'transcript', tenant_id, recording_id::text, source_expires_at
  FROM transcriptions
  WHERE (status = 'terminal_failure' AND updated_at >= now() - interval '15 minutes')
    OR (status IN ('preparing', 'transcribing', 'verifying', 'retryable_failure')
      AND created_at < now() - interval '30 minutes')
  UNION ALL
  SELECT 'webhook', tenant_id, id::text, NULL::timestamptz
  FROM webhook_deliveries
  WHERE state = 'exhausted' AND terminal_at >= now() - interval '15 minutes'
), subjects AS (
  SELECT id::text AS tenant, name FROM tenants
  UNION ALL SELECT '', ''
), rules AS (
  SELECT unnest(ARRAY['recording', 'export', 'transcript', 'webhook']) AS rule
)
SELECT rules.rule, subjects.tenant, subjects.name, count(DISTINCT failures.item),
  min(failures.expires_at), count(*) FILTER (WHERE failures.item IS NOT NULL AND failures.expires_at IS NULL)
FROM subjects CROSS JOIN rules
LEFT JOIN failures ON failures.tenant_id::text = subjects.tenant AND failures.rule = rules.rule
GROUP BY rules.rule, subjects.tenant, subjects.name;
