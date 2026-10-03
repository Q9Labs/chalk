SELECT 'recording' AS rule, count(*) AS value,
  'A user saw a Recording fail during Capture or Render; start with `pnpm diag trace <32-hex-trace-id>` using the job journey ID.' AS summary
FROM recording_jobs
WHERE kind IN ('capture', 'render') AND state = 'terminal_failure'
  AND terminal_at >= now() - interval '15 minutes'
UNION ALL
SELECT 'export', count(*),
  'A user saw an Export fail or remain unavailable past the 14-hour Render budget; start with `pnpm diag trace <32-hex-trace-id>` using the render job journey ID.'
FROM recording_jobs
WHERE kind = 'render' AND (
  (state = 'terminal_failure' AND terminal_at >= now() - interval '15 minutes')
  OR (state IN ('pending', 'leased', 'retryable_failure') AND created_at < now() - interval '14 hours')
)
UNION ALL
SELECT 'transcript', count(*),
  'A user saw a Transcript fail or remain unavailable past 30 minutes; start with `pnpm diag trace <32-hex-trace-id>` using the Transcript journey ID.'
FROM transcriptions
WHERE (status = 'terminal_failure' AND updated_at >= now() - interval '15 minutes')
  OR (status IN ('preparing', 'transcribing', 'verifying', 'retryable_failure') AND created_at < now() - interval '30 minutes')
UNION ALL
SELECT 'webhook', count(*),
  'A customer did not receive a webhook after Chalk exhausted retries; start with `pnpm diag trace <32-hex-trace-id>` from the Delivery Attempt.'
FROM webhook_deliveries
WHERE state = 'exhausted' AND terminal_at >= now() - interval '15 minutes';
