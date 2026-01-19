package transcript

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

// Ensure pgtype import is used (for UUID conversion)
var _ pgtype.UUID

var (
	ErrTranscriptNotFound = errors.New("transcript not found")
	ErrDuplicateTranscript = errors.New("transcript with this external_id already exists")
)

type Service struct {
	db *db.Queries
}

func NewService(queries *db.Queries) *Service {
	return &Service{db: queries}
}

type CreateTranscriptInput struct {
	RoomID                  uuid.UUID
	ParticipantID           *uuid.UUID
	CloudflareParticipantID string
	SpeakerName             string
	Text                    string
	Confidence              *float32
	Language                string
	ExternalID              string
	Timestamp               time.Time
}

func (s *Service) CreateTranscript(ctx context.Context, input CreateTranscriptInput) (*db.Transcript, error) {
	// Dedupe by external_id if provided
	if input.ExternalID != "" {
		existing, err := s.db.GetTranscriptByExternalID(ctx, &input.ExternalID)
		if err == nil && existing.ID != uuid.Nil {
			return &existing, nil // Already exists, return existing
		}
	}

	var participantID pgtype.UUID
	if input.ParticipantID != nil {
		participantID = pgtype.UUID{Bytes: *input.ParticipantID, Valid: true}
	}

	var confidence *float32
	if input.Confidence != nil {
		confidence = input.Confidence
	}

	transcript, err := s.db.CreateTranscript(ctx, db.CreateTranscriptParams{
		RoomID:                  input.RoomID,
		ParticipantID:           participantID,
		CloudflareParticipantID: strPtr(input.CloudflareParticipantID),
		SpeakerName:             input.SpeakerName,
		Text:                    input.Text,
		Confidence:              confidence,
		Language:                strPtr(input.Language),
		ExternalID:              strPtr(input.ExternalID),
		Timestamp:               input.Timestamp,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create transcript: %w", err)
	}
	return &transcript, nil
}

func (s *Service) GetTranscript(ctx context.Context, transcriptID uuid.UUID) (*db.Transcript, error) {
	transcript, err := s.db.GetTranscript(ctx, transcriptID)
	if err != nil {
		return nil, ErrTranscriptNotFound
	}
	return &transcript, nil
}

func (s *Service) ListTranscriptsByRoom(ctx context.Context, roomID uuid.UUID, limit, offset int32) ([]db.Transcript, error) {
	transcripts, err := s.db.ListTranscriptsByRoom(ctx, db.ListTranscriptsByRoomParams{
		RoomID: roomID,
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list transcripts: %w", err)
	}
	return transcripts, nil
}

func (s *Service) CountTranscriptsByRoom(ctx context.Context, roomID uuid.UUID) (int64, error) {
	count, err := s.db.CountTranscriptsByRoom(ctx, roomID)
	if err != nil {
		return 0, fmt.Errorf("failed to count transcripts: %w", err)
	}
	return count, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
