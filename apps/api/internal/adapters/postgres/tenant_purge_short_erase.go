package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/tenantpurge"
)

// settle checks the selected rows against the approved plan. A delete run only needs the write drain;
// a backfill run needs the same rows the plan listed, in the plan's table order.
func (run shortRun) settle(ctx context.Context, tx pgx.Tx, current *tenantpurge.Plan) error {
	if run.deleting {
		drainSelected := map[string]string{}
		for name, condition := range run.selected {
			drainSelected[name] = condition + " and cardinality($1::uuid[])>=0"
		}
		drain, err := snapshotPurgeWriteDrain(ctx, tx, run.catalog, drainSelected, []string{run.target})
		current.WriteDrain = drain
		if err != nil {
			return err
		}
		return current.WriteDrain.Validate(time.Now().UTC())
	}
	ordered := make([]tenantpurge.Table, 0, len(current.Tables))
	for _, wanted := range run.expected.Tables {
		for _, table := range current.Tables {
			if table.Name == wanted.Name {
				ordered = append(ordered, table)
			}
		}
	}
	current.Tables = ordered
	return tenantpurge.SameRows(run.expected, *current)
}

// erase runs the erase batch, then proves that exactly the selected rows left and the retained rows
// kept their digest.
func (run shortRun) erase(ctx context.Context, tx pgx.Tx, current tenantpurge.Plan, results []*pgconn.Result, sel shortSelect) error {
	erase, err := shortEraseSQL(run.catalog, current, run.deleting)
	if err != nil {
		return err
	}
	post := map[string]int{}
	for _, table := range run.catalog.Tables {
		post[table.Name] = erase.add(shortProtectedSQL(table))
	}
	if run.deleting {
		for _, guard := range run.catalog.Triggers {
			if _, known := purgeAppendOnlyGuards[guard.Name]; known {
				erase.add(`alter table ` + purgeName(guard.Table) + ` enable trigger ` + purgeQuote(guard.Name))
			}
		}
	}
	restored := erase.add(shortSchemaSQL)
	after, err := erase.run(ctx, tx)
	if err != nil {
		return fmt.Errorf("short erase: %w", err)
	}
	for _, table := range run.catalog.Tables {
		before := results[sel.protected[table.Name]].Rows[0]
		remaining := after[post[table.Name]].Rows[0]
		if err := run.checkExactErase(table.Name, current, before, remaining); err != nil {
			return err
		}
	}
	if string(after[restored].Rows[0][0]) != run.fingerprint {
		return errors.New("schema guards not restored")
	}
	return nil
}

func (run shortRun) checkExactErase(name string, current tenantpurge.Plan, before, remaining [][]byte) error {
	var selectedCount int64
	if run.deleting {
		for _, data := range current.Tables {
			if data.Name == name {
				selectedCount = data.Count
			}
		}
	}
	var n, m int64
	if _, err := fmt.Sscan(string(before[0]), &n); err != nil {
		return err
	}
	if _, err := fmt.Sscan(string(remaining[0]), &m); err != nil {
		return err
	}
	if n-m != selectedCount || string(before[1]) != string(remaining[1]) {
		return fmt.Errorf("exact erase count or retained digest mismatch in %s", name)
	}
	return nil
}

func shortEraseSQL(catalog purgeCatalog, current tenantpurge.Plan, deleting bool) (shortSQL, error) {
	if !deleting {
		b := shortSQL{}
		tenants, spaces := backfillIDs(current.Scope, *current.Backfill)
		b.add(`update public.tenant_artifact_policies set transcription_ceiling=case when transcription_ceiling='disabled' or transcription_default_mode='disabled' then 'automatic' else transcription_ceiling end,transcription_default_mode=case when transcription_default_mode='disabled' then 'automatic' else transcription_default_mode end,provider_policy_version=case when btrim(provider_policy_version)='' then 'chalk-automatic-v1' else provider_policy_version end,source_window_seconds=case when source_window_seconds=0 then 86400 else source_window_seconds end,updated_at=now() where tenant_id=any(` + purgeArray(tenants) + `) and (transcription_ceiling='disabled' or transcription_default_mode='disabled')`)
		b.add(`update public.spaces set recording_policy='automatic',transcription_policy='automatic',updated_at=now() where id=any(` + purgeArray(spaces) + `) and recording_policy='disabled' and transcription_policy='disabled'`)
		return b, nil
	}
	erase := shortSQL{}
	for _, cut := range []struct{ table, set string }{
		{"recording_transcription_sources", "lease_transcript_id=null,lease_expires_at=null,status=case when status='leased' then 'cleanup_pending' else status end,cleanup_due_at=case when status='leased' then coalesce(cleanup_due_at,now()) else cleanup_due_at end"},
		{"sync_external_operations", "applied_event_id=null,applied_revision=null"},
		{"recording_capture_connections", "active_command_id=null,active_execution_token=null,active_execution_expires_at=null"},
	} {
		table, ok := catalog.table(cut.table)
		if !ok {
			return erase, errors.New("missing cycle-cut table")
		}
		erase.add(`update ` + purgeName(cut.table) + ` d set ` + cut.set + ` where exists(select 1 from ` + shortTemp(cut.table) + ` s where ` + purgePKJoin(table, "d", "s") + `)`)
	}
	parents := map[string][]string{}
	for _, fk := range catalog.FKs {
		if fk.Child == "webhook_endpoints" && fk.Parent == "webhook_endpoint_revisions" || fk.Child == "sync_external_operations" && fk.Parent == "sync_control_events" || fk.Child == "recording_capture_connections" && fk.Parent == "recording_capture_commands" || fk.Child == "recording_transcription_sources" && fk.Parent == "transcriptions" {
			continue
		}
		parents[fk.Child] = append(parents[fk.Child], fk.Parent)
	}
	var names []string
	for _, table := range current.Tables {
		if table.Count > 0 && table.Name != "webhook_endpoint_revisions" {
			names = append(names, table.Name)
		}
	}
	order, err := tenantpurge.DeleteOrder(names, parents)
	if err != nil {
		return erase, err
	}
	for _, trigger := range catalog.Triggers {
		function, known := purgeAppendOnlyGuards[trigger.Name]
		if !known {
			continue
		}
		if function != trigger.Function || trigger.Enabled != "O" {
			return erase, errors.New("unexpected append-only guard")
		}
		erase.add(`alter table ` + purgeName(trigger.Table) + ` disable trigger ` + purgeQuote(trigger.Name))
	}
	for _, name := range order {
		table, _ := catalog.table(name)
		erase.add(`delete from ` + purgeName(name) + ` d using ` + shortTemp(name) + ` s where ` + purgePKJoin(table, "d", "s"))
	}

	return erase, nil
}
