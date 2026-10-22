package postgres

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestJoinSeatMigrationDefersExistingGenerationForeignKey(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	migration, err := migrations.Files.ReadFile("20261023100000_participant_join_seats.sql")
	if err != nil {
		t.Fatal(err)
	}
	prepareGeneration, _, found := strings.Cut(string(migration), "create table participant_join_seats")
	if !found {
		t.Fatal("migration has no seat table boundary")
	}
	for _, name := range []string{"baseline unnamed", "canonical named"} {
		t.Run(name, func(t *testing.T) {
			ctx := t.Context()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			schema := pgx.Identifier{"join_seat_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")}.Sanitize()
			if _, err := tx.Exec(ctx, "create schema "+schema+"; set local search_path to "+schema); err != nil {
				t.Fatal(err)
			}
			constraint := ""
			if name == "canonical named" {
				constraint = "constraint sync_lifecycle_intents_sync_v3_generation_fkey "
			}
			if _, err := tx.Exec(ctx, `
				create table participants (
					tenant_id bigint, space_id bigint, episode_id bigint, id bigint, generation bigint,
					unique(tenant_id,space_id,episode_id,id),
					unique(tenant_id,space_id,episode_id,id,generation)
				);
				create table sync_lifecycle_intents (
					tenant_id bigint, space_id bigint, episode_id bigint,
					participant_id bigint, participant_generation bigint,
					foreign key(tenant_id,space_id,episode_id,participant_id)
						references participants(tenant_id,space_id,episode_id,id),
					`+constraint+`foreign key(tenant_id,space_id,episode_id,participant_id,participant_generation)
						references participants(tenant_id,space_id,episode_id,id,generation)
				);
				insert into participants values(1,2,3,4,1);
				insert into sync_lifecycle_intents values(1,2,3,4,1);
			`); err != nil {
				t.Fatal(err)
			}
			var originalName string
			if err := tx.QueryRow(ctx, `select conname from pg_constraint where conrelid='sync_lifecycle_intents'::regclass and array_length(conkey,1)=5`).Scan(&originalName); err != nil {
				t.Fatal(err)
			}
			if _, err := tx.Exec(ctx, prepareGeneration); err != nil {
				t.Fatalf("prepare deployed generation constraint: %v", err)
			}
			if _, err := tx.Exec(ctx, `
				update participants set generation=2;
				update sync_lifecycle_intents set participant_generation=2;
				set constraints all immediate;
			`); err != nil {
				t.Fatalf("atomic retry generation rotation: %v", err)
			}
			var deferred bool
			if err := tx.QueryRow(ctx, `select condeferrable and condeferred from pg_constraint
				where conrelid='sync_lifecycle_intents'::regclass
				and conname=$1`, originalName).Scan(&deferred); err != nil || !deferred {
				t.Fatalf("generation constraint not deferred: %v, %v", deferred, err)
			}
		})
	}
}

func TestJoinSeatConfirmationLocksEpisodeBeforeParticipant(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), 8*time.Second)
	defer cancel()
	schema := pgx.Identifier{"seat_lock_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")}.Sanitize()
	if _, err := pool.Exec(ctx, "create schema "+schema); err != nil {
		t.Fatal(err)
	}
	defer pool.Exec(context.Background(), "drop schema "+schema+" cascade")
	setup, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Rollback(ctx)
	if _, err := setup.Exec(ctx, "set local search_path to "+schema+`;
		create table episodes(tenant_id uuid, space_id uuid, id uuid primary key, status text);
		create table sync_episode_control(tenant_id uuid, space_id uuid, episode_id uuid);
		create table participants(tenant_id uuid, space_id uuid, episode_id uuid, id uuid primary key,
			generation bigint, status text, first_joined_at timestamptz,
			unique(tenant_id,space_id,episode_id,id), unique(tenant_id,space_id,episode_id,id,generation));
		create table sync_lifecycle_intents(tenant_id uuid, space_id uuid, episode_id uuid,
			participant_id uuid, participant_generation bigint,
			foreign key(tenant_id,space_id,episode_id,participant_id,participant_generation)
			references participants(tenant_id,space_id,episode_id,id,generation));
	`); err != nil {
		t.Fatal(err)
	}
	migration, err := migrations.Files.ReadFile("20261023100000_participant_join_seats.sql")
	if err != nil {
		t.Fatal(err)
	}
	up, _, _ := strings.Cut(string(migration), "-- +goose Down")
	if _, err := setup.Exec(ctx, up); err != nil {
		t.Fatal(err)
	}
	tenant, space, episode, participant := accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t), accountTenantIntegrationID(t)
	args := []any{uuid(tenant), uuid(space), uuid(episode), uuid(participant)}
	for _, statement := range []string{
		`insert into episodes values($1,$2,$3,'active')`,
		`insert into sync_episode_control values($1,$2,$3)`,
		`insert into participants(tenant_id,space_id,episode_id,id,generation,status) values($1,$2,$3,$4,1,'joining')`,
	} {
		count := 3
		if strings.Contains(statement, "participants(") {
			count = 4
		}
		if _, err := setup.Exec(ctx, statement, args[:count]...); err != nil {
			t.Fatal(err)
		}
	}
	if err := setup.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	retry, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer retry.Rollback(ctx)
	confirmation, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer confirmation.Rollback(ctx)
	for _, tx := range []pgx.Tx{retry, confirmation} {
		if _, err := tx.Exec(ctx, "set local search_path to "+schema); err != nil {
			t.Fatal(err)
		}
	}
	// resolveAdmissionRetry holds the Episode before asking for its participant.
	if _, err := retry.Exec(ctx, `select 1 from episodes where id=$1 for update`, uuid(episode)); err != nil {
		t.Fatal(err)
	}
	var confirmationPID int
	if err := confirmation.QueryRow(ctx, `select pg_backend_pid()`).Scan(&confirmationPID); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, err := confirmation.Exec(ctx, `select transition_participant_join_seat($1,$2,$3,$4,1,'confirm')`, args...)
		if err == nil {
			// Lifecycle.apply_pending_lifecycle takes this lock after the transition.
			_, err = confirmation.Exec(ctx, `select 1 from episodes where id=$1 for update`, uuid(episode))
		}
		if err == nil {
			err = confirmation.Commit(ctx)
		}
		finished <- err
	}()
	for {
		var blocked bool
		if err := pool.QueryRow(ctx, `select cardinality(pg_blocking_pids($1)) > 0`, confirmationPID).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case err := <-finished:
			t.Fatalf("confirmation did not wait for the Episode: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	if _, err := retry.Exec(ctx, `set local lock_timeout='300ms'`); err != nil {
		t.Fatal(err)
	}
	_, lockErr := retry.Exec(ctx, `select 1 from participants where id=$1 for update`, uuid(participant))
	if lockErr != nil {
		_ = retry.Rollback(ctx)
		<-finished
		t.Fatalf("confirmation held the participant while waiting for the Episode: %v", lockErr)
	}
	if err := retry.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
}
