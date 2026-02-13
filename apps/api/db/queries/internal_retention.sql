-- Internal Retention Queries
-- Delete recordings after retention window (internal tenants only)

-- name: ListInternalRecordingsForDeletion :many
SELECT rec.* FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
JOIN tenants t ON t.id = r.tenant_id
WHERE t.tenant_kind = 'internal'
  AND rec.ended_at IS NOT NULL
  AND rec.ended_at < NOW() - make_interval(days => sqlc.arg(retention_days)::int)
  AND rec.status IN ('ready', 'archived', 'failed')
ORDER BY rec.ended_at ASC
LIMIT sqlc.arg(batch_size);
