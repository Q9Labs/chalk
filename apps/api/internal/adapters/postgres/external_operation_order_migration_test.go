package postgres

import (
	"context"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/stdlib"
	"github.com/pressly/goose/v3"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestExternalOperationOrderMigrationWithEnforcedEntryWriter(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx := t.Context()
	schema := "operation_order_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")
	if _, err := pool.Exec(ctx, "create schema "+schema); err != nil {
		t.Fatal(err)
	}
	defer func() {
		if _, err := pool.Exec(context.WithoutCancel(ctx), "drop schema "+schema+" cascade"); err != nil {
			t.Error(err)
		}
	}()
	config := pool.Config().ConnConfig.Copy()
	config.RuntimeParams["search_path"] = schema
	db := stdlib.OpenDB(*config)
	defer db.Close()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.ExecContext(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`create table sync_entry_rollout (singleton boolean primary key, enforced boolean);
		insert into sync_entry_rollout values (true, true);
		create table sync_external_operations (like public.sync_external_operations including all);
		alter table sync_external_operations drop column acceptance_order;
		create trigger sync_entry_leave_writer before insert or update on sync_external_operations
			for each row when (new.operation_name='participant_leave')
			execute function public.require_sync_entry_writer()`)
	history := 2000
	if value := os.Getenv("CHALK_OPERATION_ORDER_SCALE_ROWS"); value != "" {
		var err error
		history, err = strconv.Atoi(value)
		if err != nil || history < 1 {
			t.Fatal("CHALK_OPERATION_ORDER_SCALE_ROWS must be positive")
		}
	}
	exec(`insert into sync_external_operations
		(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,payload,status,completed_at,created_at)
		select '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
		gen_random_uuid(),'history_'||lpad(n::text,16,'0'),decode(repeat('aa',32),'hex'),'tenant_end_episode','{}','applied',now(),now()-n*interval '1 millisecond'
		from generate_series(1,$1::integer) n`, history)
	exec(`begin; select set_config('chalk.entry_writer','1',true);
		insert into sync_external_operations
		(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,payload,created_at)
		select '00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
		gen_random_uuid(),'legacy_pending_'||lpad(n::text,16,'0'),decode(repeat('aa',32),'hex'),'participant_leave','{}',now()+n*interval '1 millisecond'
		from generate_series(1,2001) n; commit`)
	exec("analyze sync_external_operations")

	migration, err := migrations.Files.ReadFile("20261031090000_sync_external_operation_acceptance_order.sql")
	if err != nil {
		t.Fatal(err)
	}
	provider, err := goose.NewProvider(goose.DialectPostgres, db, fstest.MapFS{
		"20261031090000_sync_external_operation_acceptance_order.sql": {Data: migration},
	}, goose.WithLogger(goose.NopLogger()))
	if err != nil {
		t.Fatal(err)
	}

	// Old binaries keep claiming and inserting while every migration phase runs.
	// Measure whole operation latency, an upper bound on time blocked by a lock.
	probeCtx, stop := context.WithCancel(ctx)
	var workers sync.WaitGroup
	type observation struct {
		kind    string
		count   int
		maximum time.Duration
		err     error
	}
	observed := make(chan observation, 2)
	ready := make(chan struct{}, 2)
	for _, kind := range []string{"claim", "insert"} {
		workers.Go(func() {
			result := observation{kind: kind}
			defer func() { observed <- result }()
			connection, err := pgx.ConnectConfig(ctx, config)
			if err != nil {
				result.err = err
				ready <- struct{}{}
				return
			}
			defer connection.Close(context.WithoutCancel(ctx))
			if _, err := connection.Exec(ctx, "set lock_timeout='750ms'; set statement_timeout='2s'"); err != nil {
				result.err = err
				ready <- struct{}{}
				return
			}
			ticker := time.NewTicker(5 * time.Millisecond)
			defer ticker.Stop()
			for {
				started := time.Now()
				query := `with candidates as (
					select external_operation_id from sync_external_operations
					where status='pending' and next_attempt_at<=now() and attempt_count<100
					order by next_attempt_at,attempt_count,created_at,external_operation_id
					for update skip locked limit 32
				) update sync_external_operations operation
				set attempt_count=operation.attempt_count+1,next_attempt_at=now()+interval '60 seconds'
				from candidates where operation.external_operation_id=candidates.external_operation_id`
				if kind == "insert" {
					query = `insert into sync_external_operations
						(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,payload,status,completed_at)
						values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
						gen_random_uuid(),'live_'||replace(gen_random_uuid()::text,'-',''),decode(repeat('aa',32),'hex'),'tenant_end_episode','{}','applied',now())`
				}
				// The claim updates historical Leaves, exercising writer enforcement.
				_, err := connection.Exec(ctx, "begin; select set_config('chalk.entry_writer','1',true); "+query+"; commit")
				result.maximum = max(result.maximum, time.Since(started))
				result.count++
				if result.count == 1 {
					ready <- struct{}{}
				}
				if err != nil {
					result.err = err
					return
				}
				select {
				case <-probeCtx.Done():
					return
				case <-ticker.C:
				}
			}
		})
	}
	<-ready
	<-ready
	var startWAL string
	var relationBytes int64
	if err := db.QueryRowContext(ctx, `select pg_current_wal_lsn()::text,pg_total_relation_size('sync_external_operations')`).Scan(&startWAL, &relationBytes); err != nil {
		stop()
		workers.Wait()
		t.Fatal(err)
	}
	started := time.Now()
	_, migrationErr := provider.Up(ctx)
	elapsed := time.Since(started)
	stop()
	workers.Wait()
	close(observed)
	for result := range observed {
		t.Logf("ORDER_MIGRATION rows=%d elapsed=%s %s_count=%d maximum_%s_latency=%s errors=%v", history, elapsed, result.kind, result.count, result.kind, result.maximum, result.err)
		if result.err != nil || result.maximum >= 750*time.Millisecond {
			t.Errorf("migration interrupted %s: maximum=%s error=%v", result.kind, result.maximum, result.err)
		}
	}
	if migrationErr != nil {
		t.Fatal(migrationErr)
	}
	var walBytes int64
	if err := db.QueryRowContext(ctx, `select pg_wal_lsn_diff(pg_current_wal_lsn(),$1::pg_lsn)::bigint`, startWAL).Scan(&walBytes); err != nil {
		t.Fatal(err)
	}
	t.Logf("ORDER_MIGRATION_STORAGE history=%d legacy_pending=2001 relation_bytes=%d wal_bytes=%d", history, relationBytes, walBytes)
	var untouched, ordered, batches bool
	if err := db.QueryRowContext(ctx, `select
		(select count(*)=$1 and bool_and(acceptance_order is null) from sync_external_operations where request_key like 'history_%'),
		(select count(*)=2001 and bool_and(acceptance_order<0) from sync_external_operations where request_key like 'legacy_pending_%'),
		(select count(distinct xmin::text)>=3 from sync_external_operations where request_key like 'legacy_pending_%')`, history).Scan(&untouched, &ordered, &batches); err != nil || !untouched || !ordered || !batches {
		t.Fatalf("history untouched=%v pending ordered=%v separately committed batches=%v: %v", untouched, ordered, batches, err)
	}
	var inverted int
	if err := db.QueryRowContext(ctx, `select count(*) from (
		select acceptance_order,lag(acceptance_order) over(order by created_at,external_operation_id) previous
		from sync_external_operations where request_key like 'legacy_pending_%'
	) ordered where acceptance_order<=previous`).Scan(&inverted); err != nil || inverted != 0 {
		t.Fatalf("legacy order inverted: %d, %v", inverted, err)
	}
	// Replay after a crash between successful Up and Goose's version recording.
	var beforeReplay string
	if err := db.QueryRowContext(ctx, `select md5(string_agg(acceptance_order::text,',' order by external_operation_id)) from sync_external_operations`).Scan(&beforeReplay); err != nil {
		t.Fatal(err)
	}
	exec("delete from goose_db_version where version_id=20261031090000")
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	var afterReplay string
	if err := db.QueryRowContext(ctx, `select md5(string_agg(acceptance_order::text,',' order by external_operation_id)) from sync_external_operations`).Scan(&afterReplay); err != nil || beforeReplay != afterReplay {
		t.Fatalf("replay changed acceptance orders: %v", err)
	}
	var next int64
	if err := db.QueryRowContext(ctx, `insert into sync_external_operations
		(tenant_id,space_id,episode_id,external_operation_id,request_key,request_fingerprint,operation_name,payload)
		values ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
		gen_random_uuid(),'new_after_backfill',decode(repeat('aa',32),'hex'),'tenant_end_episode','{}') returning acceptance_order`).Scan(&next); err != nil || next <= 0 {
		t.Fatalf("new insert order=%d: %v", next, err)
	}
	if _, err := provider.Down(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := provider.Up(ctx); err != nil {
		t.Fatal(err)
	}
	t.Logf("ORDER_MIGRATION_COMPLETE history=%d legacy_pending=2001", history)
}
