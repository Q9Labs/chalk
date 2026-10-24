package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/episodes"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

// The Sync wire tests invoke this probe against their committed fixtures so the
// production API scheduler and Sync consumer share the same authority rows.
func TestDroppedPresenceLifecycleProbe(t *testing.T) {
	action := os.Getenv("CHALK_PRESENCE_PROBE_ACTION")
	if action == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, os.Getenv("CHALK_SYNC_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	repository := NewEpisodeLifecycleRepository(pool)
	switch action {
	case "tick":
		count, err := repository.EnqueueDueEpisodeDeadlines(ctx, 50)
		if err != nil {
			t.Fatal(err)
		}
		fmt.Printf("PRESENCE_PROBE=%d\n", count)
	case "rejoin":
		parse := func(name string) utilities.ID {
			t.Helper()
			id, err := utilities.ParseID(os.Getenv(name))
			if err != nil {
				t.Fatal(err)
			}
			return id
		}
		participant, err := utilities.NewID()
		if err != nil {
			t.Fatal(err)
		}
		admission, err := repository.AdmitParticipant(ctx, episodes.AdmitParticipantInput{
			TenantID: parse("CHALK_PRESENCE_TENANT"), SpaceID: parse("CHALK_PRESENCE_SPACE"),
			EpisodeID: parse("CHALK_PRESENCE_EPISODE"), ParticipantID: participant,
			Name: "Returning participant", Role: "owner", Admission: episodes.AdmissionDirect,
			Request: episodes.Request{Key: "presence-rejoin-" + participant.String()},
		})
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(map[string]any{
			"participant_id": admission.Participant.ID.String(),
			"generation":     admission.Participant.Generation,
			"intent_id":      admission.Intent.ID.String(),
		})
		if err != nil {
			t.Fatal(err)
		}
		fmt.Printf("PRESENCE_PROBE=%s\n", encoded)
	default:
		t.Fatalf("unknown probe action %q", action)
	}
}
