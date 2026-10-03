package postgres

import (
	"context"
	"errors"
	"github.com/jackc/pgx/v5"
)

// Only product-owned append-only DELETE guards are suspended, with SQL
// writers fenced. FK/check constraints stay enabled. DDL rolls back with the
// purge on every failure, and these exact guards are restored before commit.
var purgeAppendOnlyGuards = map[string]string{
	"recording_job_attempt_authorities_immutable": "reject_recording_job_attempt_authority_mutation",
	"recording_capture_plans_immutable":           "reject_recording_capture_plan_mutation",
	"recording_capture_connections_no_delete":     "reject_recording_capture_queue_delete",
	"recording_capture_commands_no_delete":        "reject_recording_capture_queue_delete",
	"recording_data_keys_immutable":               "protect_recording_data_key_mutation",
	"recording_bundle_allocations_no_delete":      "reject_recording_bundle_allocation_delete",
	"recording_presentation_baselines_immutable":  "reject_recording_presentation_mutation",
	"recording_presentation_sources_immutable":    "reject_recording_presentation_mutation",
	"recording_presentations_immutable":           "reject_recording_presentation_mutation",
	"recording_presentation_assets_immutable":     "reject_recording_presentation_mutation",
	"recording_presentation_reactions_immutable":  "reject_recording_presentation_mutation",
	"recording_render_inputs_immutable":           "reject_recording_render_authority_mutation",
	"recording_render_commits_immutable":          "reject_recording_render_authority_mutation",
	"recording_render_allocations_no_delete":      "reject_recording_render_authority_mutation",
}

func suspendPurgeGuards(ctx context.Context, tx pgx.Tx, catalog purgeCatalog, selected map[string]string) ([]purgeTrigger, error) {
	var suspended []purgeTrigger
	for _, trigger := range catalog.Triggers {
		function, known := purgeAppendOnlyGuards[trigger.Name]
		if !known || selected[trigger.Table] == "" {
			continue
		}
		if function != trigger.Function || trigger.Enabled != "O" {
			return nil, errors.New("unexpected append-only guard definition or enabled state")
		}
		if _, err := tx.Exec(ctx, `alter table `+purgeName(trigger.Table)+` disable trigger `+purgeQuote(trigger.Name)); err != nil {
			return nil, err
		}
		suspended = append(suspended, trigger)
	}
	return suspended, nil
}

func restorePurgeGuards(ctx context.Context, tx pgx.Tx, suspended []purgeTrigger) error {
	for _, trigger := range suspended {
		if _, err := tx.Exec(ctx, `alter table `+purgeName(trigger.Table)+` enable trigger `+purgeQuote(trigger.Name)); err != nil {
			return err
		}
	}
	return nil
}
