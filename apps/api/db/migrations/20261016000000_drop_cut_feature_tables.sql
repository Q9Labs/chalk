-- +goose Up
-- Approved lean cuts. Keep this migration separate from product code so it can
-- be held back. Kept recording, transcript, Space, auth and webhook tables are
-- deliberately not included; no CASCADE may hide an external dependency.
drop table
    showcase_dataset_registries,
    audit_logs,
    integration_connections,
    status_monitor_results,
    status_monitor_current,
    diagnostic_environment_ownership,
    episode_diagnostics,
    episode_diagnostic_cursor_heads,
    diagnostic_branches,
    diagnostic_operations,
    diagnostic_checkpoints,
    diagnostic_issues,
    diagnostic_events,
    diagnostic_participant_projections,
    diagnostic_references,
    diagnostic_projector_offsets,
    diagnostic_projection_changes,
    diagnostic_projector_dead_letters,
    diagnostic_export_jobs,
    diagnostic_export_artifact_chunks,
    feedback_reports,
    tenant_invitations;

-- +goose Down
-- +goose StatementBegin
do $$ begin
    raise exception 'Cut feature data cannot be restored by a down migration; restore a backup instead';
end $$;
-- +goose StatementEnd
