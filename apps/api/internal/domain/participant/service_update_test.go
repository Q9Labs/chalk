package participant

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

type updateParticipantDBStub struct {
	participant db.Participant
}

func (d *updateParticipantDBStub) ActivateScheduledRoom(context.Context, uuid.UUID) (db.Room, error) {
	panic("unexpected ActivateScheduledRoom")
}

func (d *updateParticipantDBStub) CountActiveParticipantsByRoom(context.Context, uuid.UUID) (int64, error) {
	panic("unexpected CountActiveParticipantsByRoom")
}

func (d *updateParticipantDBStub) CreateParticipant(context.Context, db.CreateParticipantParams) (db.Participant, error) {
	panic("unexpected CreateParticipant")
}

func (d *updateParticipantDBStub) CreateRoomWithID(context.Context, db.CreateRoomWithIDParams) (db.Room, error) {
	panic("unexpected CreateRoomWithID")
}

func (d *updateParticipantDBStub) GetActiveRecordingByRoom(context.Context, uuid.UUID) (db.Recording, error) {
	panic("unexpected GetActiveRecordingByRoom")
}

func (d *updateParticipantDBStub) GetParticipant(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected GetParticipant")
}

func (d *updateParticipantDBStub) GetParticipantByCloudflareID(context.Context, string) (db.Participant, error) {
	panic("unexpected GetParticipantByCloudflareID")
}

func (d *updateParticipantDBStub) GetParticipantByExternalUserAndRoom(context.Context, db.GetParticipantByExternalUserAndRoomParams) (db.Participant, error) {
	panic("unexpected GetParticipantByExternalUserAndRoom")
}

func (d *updateParticipantDBStub) GetRoom(context.Context, uuid.UUID) (db.Room, error) {
	panic("unexpected GetRoom")
}

func (d *updateParticipantDBStub) GetRoomHost(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected GetRoomHost")
}

func (d *updateParticipantDBStub) GetRoomWithParticipantCount(context.Context, uuid.UUID) (db.GetRoomWithParticipantCountRow, error) {
	panic("unexpected GetRoomWithParticipantCount")
}

func (d *updateParticipantDBStub) GetTenant(context.Context, uuid.UUID) (db.Tenant, error) {
	panic("unexpected GetTenant")
}

func (d *updateParticipantDBStub) ListActiveParticipantsByRoom(context.Context, uuid.UUID) ([]db.Participant, error) {
	panic("unexpected ListActiveParticipantsByRoom")
}

func (d *updateParticipantDBStub) ListParticipantsByRoom(context.Context, uuid.UUID) ([]db.Participant, error) {
	panic("unexpected ListParticipantsByRoom")
}

func (d *updateParticipantDBStub) ParticipantLeave(context.Context, uuid.UUID) (db.Participant, error) {
	panic("unexpected ParticipantLeave")
}

func (d *updateParticipantDBStub) ReactivateRoom(context.Context, db.ReactivateRoomParams) (db.Room, error) {
	panic("unexpected ReactivateRoom")
}

func (d *updateParticipantDBStub) UpdateParticipant(_ context.Context, arg db.UpdateParticipantParams) (db.Participant, error) {
	d.participant.ID = arg.ID
	d.participant.DisplayName = arg.DisplayName
	if arg.Role != nil {
		d.participant.Role = *arg.Role
	}
	return d.participant, nil
}

type updateParticipantRoomStateStub struct {
	lastRoomID        uuid.UUID
	lastParticipantID uuid.UUID
	lastMeta          domain.ParticipantMetadata
}

func (s *updateParticipantRoomStateStub) AddParticipant(_ context.Context, roomID, participantID uuid.UUID, meta domain.ParticipantMetadata) error {
	s.lastRoomID = roomID
	s.lastParticipantID = participantID
	s.lastMeta = meta
	return nil
}

func (s *updateParticipantRoomStateStub) RemoveParticipant(context.Context, uuid.UUID, uuid.UUID) error {
	panic("unexpected RemoveParticipant")
}

func (s *updateParticipantRoomStateStub) GetParticipants(context.Context, uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error) {
	panic("unexpected GetParticipants")
}

type updateParticipantHubStub struct {
	lastParticipantID uuid.UUID
	lastMeta          domain.ParticipantMetadata
	lastRoomID        uuid.UUID
	lastMessage       []byte
	lastExcludeID     string
}

func (h *updateParticipantHubStub) SetParticipantMetadata(participantID uuid.UUID, meta domain.ParticipantMetadata) {
	h.lastParticipantID = participantID
	h.lastMeta = meta
}

func (h *updateParticipantHubStub) RemoveParticipantMetadata(uuid.UUID) {
	panic("unexpected RemoveParticipantMetadata")
}

func (h *updateParticipantHubStub) GetParticipantsInRoom(uuid.UUID) []uuid.UUID {
	panic("unexpected GetParticipantsInRoom")
}

func (h *updateParticipantHubStub) BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	h.lastRoomID = roomID
	h.lastMessage = append([]byte(nil), message...)
	h.lastExcludeID = excludeParticipantID
}

func TestUpdateParticipant_BroadcastsStructuredParticipantUpdated(t *testing.T) {
	participantID := uuid.New()
	roomID := uuid.New()
	displayName := "Alicia"
	joinedAt := time.Date(2026, time.March, 9, 12, 0, 0, 0, time.UTC)

	dbStub := &updateParticipantDBStub{
		participant: db.Participant{
			ID:          participantID,
			RoomID:      roomID,
			DisplayName: &displayName,
			Role:        "participant",
			JoinedAt:    pgtype.Timestamptz{Time: joinedAt, Valid: true},
			CreatedAt:   joinedAt.Add(-time.Hour),
		},
	}
	roomState := &updateParticipantRoomStateStub{}
	hub := &updateParticipantHubStub{}
	svc := NewService(dbStub, nil, roomState, nil, hub, nil)

	updated, err := svc.UpdateParticipant(context.Background(), participantID, &displayName, nil)
	require.NoError(t, err)
	require.NotNil(t, updated)
	require.Equal(t, displayName, *updated.DisplayName)

	require.Equal(t, roomID, roomState.lastRoomID)
	require.Equal(t, participantID, roomState.lastParticipantID)
	require.Equal(t, joinedAt, roomState.lastMeta.JoinedAt)
	require.Equal(t, displayName, roomState.lastMeta.DisplayName)

	require.Equal(t, participantID, hub.lastParticipantID)
	require.Equal(t, displayName, hub.lastMeta.DisplayName)
	require.Equal(t, roomID, hub.lastRoomID)
	require.Empty(t, hub.lastExcludeID)

	var envelope struct {
		Type    string `json:"type"`
		Payload struct {
			ParticipantID string `json:"participant_id"`
			Changes       struct {
				DisplayName string `json:"display_name"`
			} `json:"changes"`
		} `json:"payload"`
	}
	require.NoError(t, json.Unmarshal(hub.lastMessage, &envelope))
	require.Equal(t, "participant.updated", envelope.Type)
	require.Equal(t, participantID.String(), envelope.Payload.ParticipantID)
	require.Equal(t, displayName, envelope.Payload.Changes.DisplayName)
}
