package postgres

import (
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/q9labs/chalk/apps/api/db/migrations"
)

func TestJoinSeatMigrationDefersExistingGenerationForeignKey(t *testing.T) {
	pool := accountTenantIntegrationPool(t)
	migration, err := migrations.Files.ReadFile("20261021130000_participant_join_seats.sql")
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
				and conname='sync_lifecycle_intents_sync_v3_generation_fkey'`).Scan(&deferred); err != nil || !deferred {
				t.Fatalf("generation constraint not deferred: %v, %v", deferred, err)
			}
		})
	}
}
