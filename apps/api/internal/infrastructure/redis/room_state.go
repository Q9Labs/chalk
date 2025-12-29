package redis

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
)

const (
	roomParticipantsKey = "room:%s:participants"
	roomRecordingKey    = "room:%s:recording"
	participantTTL      = 2 * time.Hour
)

type ParticipantMetadata struct {
	DisplayName string    `json:"display_name"`
	Role        string    `json:"role"`
	JoinedAt    time.Time `json:"joined_at"`
}

type RecordingState struct {
	IsRecording bool       `json:"is_recording"`
	RecordingID *uuid.UUID `json:"recording_id,omitempty"`
}

type RoomState struct {
	client *Client
}

func NewRoomState(client *Client) *RoomState {
	return &RoomState{client: client}
}

func (r *RoomState) AddParticipant(ctx context.Context, roomID, participantID uuid.UUID, meta ParticipantMetadata) error {
	key := fmt.Sprintf(roomParticipantsKey, roomID.String())
	data, err := json.Marshal(meta)
	if err != nil {
		return fmt.Errorf("failed to marshal participant metadata: %w", err)
	}

	return r.client.GetClient().HSet(ctx, key, participantID.String(), data).Err()
}

func (r *RoomState) RemoveParticipant(ctx context.Context, roomID, participantID uuid.UUID) error {
	key := fmt.Sprintf(roomParticipantsKey, roomID.String())
	return r.client.GetClient().HDel(ctx, key, participantID.String()).Err()
}

func (r *RoomState) GetParticipants(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]ParticipantMetadata, error) {
	key := fmt.Sprintf(roomParticipantsKey, roomID.String())
	result, err := r.client.GetClient().HGetAll(ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get participants: %w", err)
	}

	participants := make(map[uuid.UUID]ParticipantMetadata, len(result))
	for pidStr, data := range result {
		pid, err := uuid.Parse(pidStr)
		if err != nil {
			continue
		}
		var meta ParticipantMetadata
		if err := json.Unmarshal([]byte(data), &meta); err != nil {
			continue
		}
		participants[pid] = meta
	}

	return participants, nil
}

func (r *RoomState) SetRecordingState(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error {
	key := fmt.Sprintf(roomRecordingKey, roomID.String())
	state := RecordingState{
		IsRecording: isRecording,
		RecordingID: recordingID,
	}

	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("failed to marshal recording state: %w", err)
	}

	return r.client.Set(ctx, key, data, participantTTL)
}

func (r *RoomState) GetRecordingState(ctx context.Context, roomID uuid.UUID) (*RecordingState, error) {
	key := fmt.Sprintf(roomRecordingKey, roomID.String())
	data, err := r.client.Get(ctx, key)
	if err != nil {
		return nil, err
	}

	var state RecordingState
	if err := json.Unmarshal([]byte(data), &state); err != nil {
		return nil, fmt.Errorf("failed to unmarshal recording state: %w", err)
	}

	return &state, nil
}

func (r *RoomState) ClearRoom(ctx context.Context, roomID uuid.UUID) error {
	participantsKey := fmt.Sprintf(roomParticipantsKey, roomID.String())
	recordingKey := fmt.Sprintf(roomRecordingKey, roomID.String())

	return r.client.Del(ctx, participantsKey, recordingKey)
}

func (r *RoomState) SetParticipantTTL(ctx context.Context, roomID uuid.UUID) error {
	key := fmt.Sprintf(roomParticipantsKey, roomID.String())
	return r.client.GetClient().Expire(ctx, key, participantTTL).Err()
}
