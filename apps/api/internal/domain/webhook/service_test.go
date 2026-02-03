package webhook

import (
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

func TestBuildPayload_IncludesParticipantMetadata(t *testing.T) {
	svc := &Service{}
	now := time.Date(2026, 1, 15, 10, 0, 0, 0, time.UTC)

	displayName := "Jane Doe"
	externalUserID := "user_12345"

	participants := []db.Participant{
		{
			ID:             uuid.New(),
			DisplayName:    &displayName,
			ExternalUserID: &externalUserID,
			Role:           "host",
			JoinedAt:       pgtype.Timestamptz{Time: now, Valid: true},
			LeftAt:         pgtype.Timestamptz{Time: now.Add(30 * time.Minute), Valid: true},
			Metadata:       []byte(`{"externalId":"student-42","role":"teacher"}`),
		},
	}

	payload := svc.BuildPayload(
		db.Room{ID: uuid.New()},
		nil,
		nil,
		PostMeetingWebhookConfig{},
		"",
		1,
		participants,
		nil,
	)

	if len(payload.Participants) != 1 {
		t.Fatalf("expected 1 participant, got %d", len(payload.Participants))
	}

	participant := payload.Participants[0]
	if participant.ExternalUserID == nil || *participant.ExternalUserID != externalUserID {
		t.Fatalf("expected external_user_id %q", externalUserID)
	}
	if participant.ExternalID == nil || *participant.ExternalID != "student-42" {
		t.Fatalf("expected external_id %q", "student-42")
	}
	if participant.Metadata == nil {
		t.Fatal("expected metadata to be present")
	}
}
