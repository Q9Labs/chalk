package room

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

type CloudflareClient interface {
	CreateMeeting(ctx context.Context, req cloudflare.CreateMeetingRequest) (*cloudflare.Meeting, error)
	GetMeeting(ctx context.Context, meetingID string) (*cloudflare.Meeting, error)
	EndMeeting(ctx context.Context, meetingID string) (*cloudflare.Meeting, error)
}

type RoomStateManager interface {
	ClearRoom(ctx context.Context, roomID uuid.UUID) error
	GetParticipants(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error)
	SetRecordingState(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error
	GetRecordingState(ctx context.Context, roomID uuid.UUID) (*domain.RecordingState, error)
}

type WebSocketHub interface {
	BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string)
	GetParticipantsInRoom(roomID uuid.UUID) []uuid.UUID
	SetRoomRecordingState(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID)
}

type Service struct {
	db        *db.Queries
	cfClient  CloudflareClient
	roomState RoomStateManager
	hub       WebSocketHub
}

func NewService(queries *db.Queries, cf CloudflareClient, roomState RoomStateManager, hub WebSocketHub) *Service {
	return &Service{
		db:        queries,
		cfClient:  cf,
		roomState: roomState,
		hub:       hub,
	}
}

type CreateRoomInput struct {
	TenantID uuid.UUID
	Name     string
	Config   []byte
}

type CreateRoomOutput struct {
	RoomID              uuid.UUID
	CloudflareMeetingID string
	Room                *db.Room
}

func (s *Service) CreateRoom(ctx context.Context, input CreateRoomInput) (*CreateRoomOutput, error) {

	tenant, err := s.db.GetTenant(ctx, input.TenantID)
	if err != nil {
		return nil, fmt.Errorf("error getting tenant: %w", err)
	}

	activeRooms, err := s.db.CountActiveRoomsByTenant(ctx, tenant.ID)
	if err != nil {
		return nil, fmt.Errorf("error getting active tenant rooms: %w", err)
	}

	if activeRooms >= int64(tenant.MaxConcurrentRooms) {
		return nil, fmt.Errorf("maximum concurrent room limit reached: %w", err)
	}
	cfMeeting, err := s.cfClient.CreateMeeting(ctx, cloudflare.CreateMeetingRequest{
		Title: input.Name,
	})
	if err != nil {
		return nil, fmt.Errorf("cloudflare meeting creation failed: %w", err)
	}

	room, err := s.db.CreateRoom(ctx, db.CreateRoomParams{
		TenantID:            input.TenantID,
		CloudflareMeetingID: cfMeeting.ID,
		Name:                strPtr(input.Name),
		Config:              input.Config,
	})
	if err != nil {
		// Rollback: delete orphaned Cloudflare meeting
		_, _ = s.cfClient.EndMeeting(ctx, cfMeeting.ID)
		return nil, fmt.Errorf("database insert failed: %w", err)
	}

	return &CreateRoomOutput{
		RoomID:              room.ID,
		CloudflareMeetingID: cfMeeting.ID,
		Room:                &room,
	}, nil
}

func (s *Service) GetRoom(ctx context.Context, roomID uuid.UUID) (*db.Room, error) {
	room, err := s.db.GetRoom(ctx, roomID)
	if err != nil {
		return nil, fmt.Errorf("room not found: %w", err)
	}
	return &room, nil
}

func (s *Service) GetRoomByCloudflareID(ctx context.Context, cloudflareMeetingID string) (*db.Room, error) {
	room, err := s.db.GetRoomByCloudflareID(ctx, cloudflareMeetingID)
	if err != nil {
		return nil, fmt.Errorf("room not found: %w", err)
	}
	return &room, nil
}

func (s *Service) GetRoomWithParticipantCount(ctx context.Context, roomID uuid.UUID) (*db.GetRoomWithParticipantCountRow, error) {
	room, err := s.db.GetRoomWithParticipantCount(ctx, roomID)
	if err != nil {
		return nil, fmt.Errorf("room not found: %w", err)
	}
	return &room, nil
}

// GetRoomByName looks up a room by name within a tenant
func (s *Service) GetRoomByName(ctx context.Context, name string, tenantID uuid.UUID) (*db.Room, error) {
	room, err := s.db.GetRoomByNameAndTenant(ctx, db.GetRoomByNameAndTenantParams{
		Name:     &name,
		TenantID: tenantID,
	})
	if err != nil {
		return nil, err
	}
	return &room, nil
}

func (s *Service) ListActiveRoomsByTenant(ctx context.Context, tenantID uuid.UUID, limit, offset int32) ([]db.Room, error) {
	rooms, err := s.db.ListActiveRoomsByTenant(ctx, db.ListActiveRoomsByTenantParams{
		TenantID: tenantID,
		Limit:    limit,
		Offset:   offset,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list rooms: %w", err)
	}
	return rooms, nil
}

func (s *Service) ListActiveRoomsWithParticipantCount(ctx context.Context, tenantID uuid.UUID, limit, offset int32) ([]db.ListActiveRoomsWithParticipantCountRow, error) {
	rooms, err := s.db.ListActiveRoomsWithParticipantCount(ctx, db.ListActiveRoomsWithParticipantCountParams{
		TenantID: tenantID,
		Limit:    limit,
		Offset:   offset,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to list rooms: %w", err)
	}
	return rooms, nil
}

func (s *Service) CountActiveRoomsByTenant(ctx context.Context, tenantID uuid.UUID) (int64, error) {
	count, err := s.db.CountActiveRoomsByTenant(ctx, tenantID)
	if err != nil {
		return 0, fmt.Errorf("failed to count rooms: %w", err)
	}
	return count, nil
}

func (s *Service) EndRoom(ctx context.Context, roomID uuid.UUID) error {
	room, err := s.db.GetRoom(ctx, roomID)
	if err != nil {
		return fmt.Errorf("room not found: %w", err)
	}

	// Broadcast room.ended to all participants before cleanup
	if s.hub != nil {
		msg, _ := json.Marshal(map[string]interface{}{
			"event": "room.ended",
			"data": map[string]interface{}{
				"room_id": roomID,
			},
		})
		s.hub.BroadcastToRoom(roomID, msg, "")
	}

	_, _ = s.cfClient.EndMeeting(ctx, room.CloudflareMeetingID)

	_, err = s.db.EndRoom(ctx, roomID)
	if err != nil {
		return fmt.Errorf("failed to end room in database: %w", err)
	}

	if s.roomState != nil {
		_ = s.roomState.ClearRoom(ctx, roomID)
	}

	return nil
}

func (s *Service) UpdateRoom(ctx context.Context, roomID uuid.UUID, name *string, config []byte) (*db.Room, error) {
	room, err := s.db.UpdateRoom(ctx, db.UpdateRoomParams{
		ID:     roomID,
		Name:   name,
		Config: config,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to update room: %w", err)
	}
	return &room, nil
}

func (s *Service) DeleteRoom(ctx context.Context, roomID uuid.UUID) error {
	_ = s.EndRoom(ctx, roomID)

	if err := s.db.DeleteRoom(ctx, roomID); err != nil {
		return fmt.Errorf("failed to delete room: %w", err)
	}
	return nil
}

func (s *Service) GetActiveParticipants(ctx context.Context, roomID uuid.UUID) ([]uuid.UUID, error) {
	if s.hub != nil {
		return s.hub.GetParticipantsInRoom(roomID), nil
	}

	if s.roomState != nil {
		participants, err := s.roomState.GetParticipants(ctx, roomID)
		if err != nil {
			return nil, fmt.Errorf("failed to get participants: %w", err)
		}
		ids := make([]uuid.UUID, 0, len(participants))
		for id := range participants {
			ids = append(ids, id)
		}
		return ids, nil
	}

	return nil, nil
}

func (s *Service) IsRoomAvailable(ctx context.Context, roomID uuid.UUID) (bool, error) {
	room, err := s.db.GetRoom(ctx, roomID)
	if err != nil {
		return false, fmt.Errorf("room not found: %w", err)
	}
	return room.Status == "active", nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
