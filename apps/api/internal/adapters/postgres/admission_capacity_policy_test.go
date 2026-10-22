package postgres

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres/sqlc"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// Each transaction changes the policy in an isolated search path. A copied
// ceiling or reservation constant cannot pass these exact-boundary checks.
func proveSharedAdmissionCapacity(t *testing.T, ctx context.Context, pool *pgxpool.Pool, tenantID, spaceID utilities.ID, episodeID, participantID string, generation int64) {
	t.Helper()
	for _, dimension := range []string{"snapshot", "events", "event_bytes", "intents", "intent_bytes", "participants"} {
		for _, retry := range []bool{false, true} {
			for _, over := range []int64{0, 1} {
				t.Run(fmt.Sprintf("capacity/%s/retry=%t/over=%d", dimension, retry, over), func(t *testing.T) {
					tx, err := pool.Begin(ctx)
					if err != nil {
						t.Fatal(err)
					}
					defer tx.Rollback(ctx)
					exec := func(query string, args ...any) {
						t.Helper()
						if _, err := tx.Exec(ctx, query, args...); err != nil {
							t.Fatal(err)
						}
					}
					var state string
					if err := tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5,'cancel', (select media_connection_id from participants where id=$4))`, uuid(tenantID), uuid(spaceID), episodeID, participantID, generation).Scan(&state); err != nil || state != "cancelled" {
						t.Fatalf("cancel fixture: %s %v", state, err)
					}
					var baseSnapshot, baseEvents, baseBytes, baseIntents, baseIntentBytes int64
					if err := tx.QueryRow(ctx, `select snapshot_reserved_bytes,lifecycle_reserved_events,lifecycle_reserved_bytes,lifecycle_reserved_intents,lifecycle_reserved_intent_bytes from sync_episode_control where episode_id=$1`, episodeID).Scan(&baseSnapshot, &baseEvents, &baseBytes, &baseIntents, &baseIntentBytes); err != nil {
						t.Fatal(err)
					}
					// Half-size reservations expose hard-coded reserve/release values.
					const snapshot, bytes, events, intents, payload int64 = 1024, 8192, 2, 1, 67
					var snapshotUsed, eventUsed, eventBytesUsed, intentUsed, intentBytesUsed, participants int64
					if err := tx.QueryRow(ctx, `select snapshot_bytes+snapshot_reserved_bytes,lifecycle_event_count+lifecycle_reserved_events,lifecycle_event_bytes+lifecycle_reserved_bytes,lifecycle_intent_count+lifecycle_reserved_intents,lifecycle_intent_bytes+lifecycle_reserved_intent_bytes,(select count(*) from participants where episode_id=$1 and status in ('joining','active','leaving')) from sync_episode_control where episode_id=$1`, episodeID).Scan(&snapshotUsed, &eventUsed, &eventBytesUsed, &intentUsed, &intentBytesUsed, &participants); err != nil {
						t.Fatal(err)
					}
					actualIntents, actualBytes := int64(1), payload
					if retry {
						actualIntents, actualBytes = 0, 0
					}
					maxSnapshot, maxEvents, maxEventBytes, maxIntents, maxIntentBytes, maxParticipants := int64(1048576), int64(2048), int64(33554432), int64(2048), int64(33554432), int64(500)
					switch dimension {
					case "snapshot":
						maxSnapshot = snapshotUsed + snapshot - over
					case "events":
						maxEvents = eventUsed + events - over
					case "event_bytes":
						maxEventBytes = eventBytesUsed + events*bytes - over
					case "intents":
						maxIntents = intentUsed + actualIntents + intents - over
					case "intent_bytes":
						maxIntentBytes = intentBytesUsed + actualBytes + bytes - over
					case "participants":
						maxParticipants = participants + 1 - over
					}
					schema := pgx.Identifier{"capacity_" + strings.ReplaceAll(accountTenantIntegrationID(t).String(), "-", "")}.Sanitize()
					exec("create schema " + schema + "; set local search_path to " + schema + ",public")
					exec(fmt.Sprintf(`create function %s.sync_admission_capacity_policy() returns table(snapshot_reservation_bytes bigint,reservation_bytes bigint,admission_events bigint,reserved_intents bigint,max_snapshot_bytes bigint,max_events bigint,max_event_bytes bigint,max_intents bigint,max_intent_bytes bigint,max_participants bigint) language sql immutable as $$ select %d::bigint,%d::bigint,%d::bigint,%d::bigint,%d::bigint,%d::bigint,%d::bigint,%d::bigint,%d::bigint,%d::bigint $$`, schema, snapshot, bytes, events, intents, maxSnapshot, maxEvents, maxEventBytes, maxIntents, maxIntentBytes, maxParticipants))
					var episodeUUID pgtype.UUID
					if err := episodeUUID.Scan(episodeID); err != nil {
						t.Fatal(err)
					}
					if retry {
						err = tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5,'retry')`, uuid(tenantID), uuid(spaceID), episodeID, participantID, generation).Scan(&state)
						if err != nil {
							t.Fatal(err)
						}
						want := "pending"
						if over != 0 {
							want = "capacity_exceeded"
						}
						if state != want {
							t.Fatalf("retry %s: got %s want %s", dimension, state, want)
						}
					} else {
						_, err = sqlc.New(tx).ReserveParticipantAdmission(ctx, sqlc.ReserveParticipantAdmissionParams{TenantID: uuid(tenantID), SpaceID: uuid(spaceID), EpisodeID: episodeUUID, IntentPayloadBytes: payload})
						if over != 0 {
							if err != pgx.ErrNoRows {
								t.Fatalf("fresh %s exceeded ceiling: %v", dimension, err)
							}
							return
						}
						if err != nil {
							t.Fatal(err)
						}
					}
					if over != 0 {
						return
					}
					var reservedSnapshot, reservedEvents, reservedBytes, reservedIntents, reservedIntentBytes int64
					if err := tx.QueryRow(ctx, `select snapshot_reserved_bytes,lifecycle_reserved_events,lifecycle_reserved_bytes,lifecycle_reserved_intents,lifecycle_reserved_intent_bytes from sync_episode_control where episode_id=$1`, episodeID).Scan(&reservedSnapshot, &reservedEvents, &reservedBytes, &reservedIntents, &reservedIntentBytes); err != nil {
						t.Fatal(err)
					}
					if reservedSnapshot != baseSnapshot+snapshot || reservedEvents != baseEvents+events || reservedBytes != baseBytes+events*bytes || reservedIntents != baseIntents+intents || reservedIntentBytes != baseIntentBytes+bytes {
						t.Fatalf("reservation policy drift: %d %d %d %d %d", reservedSnapshot, reservedEvents, reservedBytes, reservedIntents, reservedIntentBytes)
					}
					if retry {
						// Cancel/rearm/expire/rearm repeatedly with the changed policy.
						for range 3 {
							var current int64
							if err := tx.QueryRow(ctx, `select generation from participants where id=$1`, participantID).Scan(&current); err != nil {
								t.Fatal(err)
							}
							exec(`update participants set media_connection_id='policy-attempt' where id=$1`, participantID)
							if err := tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5,'cancel','policy-attempt')`, uuid(tenantID), uuid(spaceID), episodeID, participantID, current).Scan(&state); err != nil || state != "cancelled" {
								t.Fatalf("cancel: %s %v", state, err)
							}
							if err := tx.QueryRow(ctx, `select snapshot_reserved_bytes+lifecycle_reserved_events+lifecycle_reserved_bytes+lifecycle_reserved_intents+lifecycle_reserved_intent_bytes from sync_episode_control where episode_id=$1`, episodeID).Scan(&reservedSnapshot); err != nil || reservedSnapshot != baseSnapshot+baseEvents+baseBytes+baseIntents+baseIntentBytes {
								t.Fatalf("cancel reservation drift: %d %v", reservedSnapshot, err)
							}
							if err := tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5,'retry')`, uuid(tenantID), uuid(spaceID), episodeID, participantID, current).Scan(&state); err != nil || state != "pending" {
								t.Fatalf("rearm: %s %v", state, err)
							}
							exec(`update participant_join_seats set expires_at=now()-interval '1 second' where participant_id=$1`, participantID)
							if err := tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5+1,'expire')`, uuid(tenantID), uuid(spaceID), episodeID, participantID, current).Scan(&state); err != nil || state != "expired" {
								t.Fatalf("expire: %s %v", state, err)
							}
							if err := tx.QueryRow(ctx, `select snapshot_reserved_bytes+lifecycle_reserved_events+lifecycle_reserved_bytes+lifecycle_reserved_intents+lifecycle_reserved_intent_bytes from sync_episode_control where episode_id=$1`, episodeID).Scan(&reservedSnapshot); err != nil || reservedSnapshot != baseSnapshot+baseEvents+baseBytes+baseIntents+baseIntentBytes {
								t.Fatalf("expiry reservation drift: %d %v", reservedSnapshot, err)
							}
							if err := tx.QueryRow(ctx, `select transition_participant_join_seat($1,$2,$3,$4,$5+1,'retry')`, uuid(tenantID), uuid(spaceID), episodeID, participantID, current).Scan(&state); err != nil || state != "pending" {
								t.Fatalf("rearm expired: %s %v", state, err)
							}
						}
					}
				})
			}
		}
	}
}
