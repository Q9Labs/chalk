package participant

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

var (
	ErrRoomNotAvailable    = errors.New("room not available")
	ErrRoomFull            = errors.New("room is full")
	ErrTenantNotFound      = errors.New("tenant does not exist")
	ErrParticipantNotFound = errors.New("participant not found")
)

type CloudflareClient interface {
	AddParticipant(ctx context.Context, meetingID string, req cloudflare.AddParticipantRequest) (*cloudflare.Participant, error)
	RemoveParticipant(ctx context.Context, meetingID, participantID string) error
	RefreshParticipantToken(ctx context.Context, meetingID, participantID string) (*cloudflare.Participant, error)
}

type RoomStateManager interface {
	AddParticipant(ctx context.Context, roomID, participantID uuid.UUID, meta domain.ParticipantMetadata) error
	RemoveParticipant(ctx context.Context, roomID, participantID uuid.UUID) error
	GetParticipants(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error)
}

type WebSocketHub interface {
	SetParticipantMetadata(participantID uuid.UUID, meta domain.ParticipantMetadata)
	RemoveParticipantMetadata(participantID uuid.UUID)
	GetParticipantsInRoom(roomID uuid.UUID) []uuid.UUID
	BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string)
}

type TokenIssuer interface {
	GenerateTokenPair(claims auth.Claims) (*auth.TokenPair, error)
}

type Service struct {
	db          *db.Queries
	cfClient    CloudflareClient
	roomState   RoomStateManager
	tokenIssuer TokenIssuer
	hub         WebSocketHub
}

func NewService(queries *db.Queries, cf CloudflareClient, roomState RoomStateManager, tokenIssuer TokenIssuer, hub WebSocketHub) *Service {
	return &Service{
		db:          queries,
		cfClient:    cf,
		roomState:   roomState,
		tokenIssuer: tokenIssuer,
		hub:         hub,
	}
}

type JoinRoomInput struct {
	RoomID         uuid.UUID
	DisplayName    string
	ExternalUserID string
	Role           string
}

type JoinRoomOutput struct {
	ParticipantID uuid.UUID
	TokenPair     *auth.TokenPair
	CFAuthToken   string
	Room          *db.Room
}

func (s *Service) JoinRoom(ctx context.Context, input JoinRoomInput) (*JoinRoomOutput, error) {
	room, err := s.db.GetRoom(ctx, input.RoomID)
	if err != nil || room.Status != "active" {
		return nil, ErrRoomNotAvailable
	}

	activeParticipantsCount, err := s.db.CountActiveParticipantsByRoom(ctx, input.RoomID)
	if err != nil {
		return nil, errors.New("error fetching participant count")
	}
	tenant, err := s.db.GetTenant(ctx, room.TenantID)
	if err != nil {
		return nil, ErrTenantNotFound
	}
	if activeParticipantsCount >= int64(tenant.MaxParticipantsPerRoom) {
		return nil, ErrRoomFull
	}

	presetName := cloudflare.PresetParticipant
	if input.Role == "host" {
		presetName = cloudflare.PresetHost
	}

	cfParticipant, err := s.cfClient.AddParticipant(ctx, room.CloudflareMeetingID, cloudflare.AddParticipantRequest{
		Name:             input.DisplayName,
		PresetName:       presetName,
		ClientSpecificID: input.ExternalUserID,
	})
	if err != nil {
		return nil, fmt.Errorf("cloudflare add participant failed: %w", err)
	}

	role := input.Role
	if role == "" {
		role = "participant"
	}

	participant, err := s.db.CreateParticipant(ctx, db.CreateParticipantParams{
		RoomID:                  input.RoomID,
		CloudflareParticipantID: cfParticipant.ID,
		ExternalUserID:          strPtr(input.ExternalUserID),
		DisplayName:             strPtr(input.DisplayName),
		Role:                    role,
	})
	if err != nil {
		return nil, fmt.Errorf("database insert failed: %w", err)
	}

	meta := domain.ParticipantMetadata{
		DisplayName: input.DisplayName,
		Role:        role,
		JoinedAt:    time.Now(),
	}

	if s.roomState != nil {
		_ = s.roomState.AddParticipant(ctx, input.RoomID, participant.ID, meta)
	}

	if s.hub != nil {
		s.hub.SetParticipantMetadata(participant.ID, meta)
	}

	tokenPair, err := s.tokenIssuer.GenerateTokenPair(auth.Claims{
		Subject:     participant.ID.String(),
		RoomID:      input.RoomID,
		TenantID:    room.TenantID,
		DisplayName: input.DisplayName,
		Role:        role,
		CFAuthToken: cfParticipant.Token,
	})
	if err != nil {
		return nil, fmt.Errorf("token generation failed: %w", err)
	}

	return &JoinRoomOutput{
		ParticipantID: participant.ID,
		TokenPair:     tokenPair,
		CFAuthToken:   cfParticipant.Token,
		Room:          &room,
	}, nil
}

func (s *Service) LeaveRoom(ctx context.Context, roomID, participantID uuid.UUID) error {
	_, err := s.db.ParticipantLeave(ctx, participantID)
	if err != nil {
		return fmt.Errorf("failed to update participant: %w", err)
	}

	if s.roomState != nil {
		_ = s.roomState.RemoveParticipant(ctx, roomID, participantID)
	}

	if s.hub != nil {
		s.hub.RemoveParticipantMetadata(participantID)
	}

	return nil
}

func (s *Service) GetParticipant(ctx context.Context, participantID uuid.UUID) (*db.Participant, error) {
	participant, err := s.db.GetParticipant(ctx, participantID)
	if err != nil {
		return nil, ErrParticipantNotFound
	}
	return &participant, nil
}

func (s *Service) GetParticipantByCloudflareID(ctx context.Context, cloudflareID string) (*db.Participant, error) {
	participant, err := s.db.GetParticipantByCloudflareID(ctx, cloudflareID)
	if err != nil {
		return nil, ErrParticipantNotFound
	}
	return &participant, nil
}

func (s *Service) ListActiveParticipantsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.Participant, error) {
	participants, err := s.db.ListActiveParticipantsByRoom(ctx, roomID)
	if err != nil {
		return nil, fmt.Errorf("failed to list participants: %w", err)
	}
	return participants, nil
}

func (s *Service) ListParticipantsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.Participant, error) {
	participants, err := s.db.ListParticipantsByRoom(ctx, roomID)
	if err != nil {
		return nil, fmt.Errorf("failed to list participants: %w", err)
	}
	return participants, nil
}

func (s *Service) CountActiveParticipantsByRoom(ctx context.Context, roomID uuid.UUID) (int64, error) {
	count, err := s.db.CountActiveParticipantsByRoom(ctx, roomID)
	if err != nil {
		return 0, fmt.Errorf("failed to count participants: %w", err)
	}
	return count, nil
}

func (s *Service) GetRoomHost(ctx context.Context, roomID uuid.UUID) (*db.Participant, error) {
	host, err := s.db.GetRoomHost(ctx, roomID)
	if err != nil {
		return nil, fmt.Errorf("host not found: %w", err)
	}
	return &host, nil
}

func (s *Service) UpdateParticipant(ctx context.Context, participantID uuid.UUID, displayName, role *string) (*db.Participant, error) {
	participant, err := s.db.UpdateParticipant(ctx, db.UpdateParticipantParams{
		ID:          participantID,
		DisplayName: displayName,
		Role:        role,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to update participant: %w", err)
	}
	return &participant, nil
}

func (s *Service) KickParticipant(ctx context.Context, roomID, participantID uuid.UUID) error {
	participant, err := s.db.GetParticipant(ctx, participantID)
	if err != nil {
		return ErrParticipantNotFound
	}

	room, err := s.db.GetRoom(ctx, roomID)
	if err != nil {
		return fmt.Errorf("room not found: %w", err)
	}

	_ = s.cfClient.RemoveParticipant(ctx, room.CloudflareMeetingID, participant.CloudflareParticipantID)

	return s.LeaveRoom(ctx, roomID, participantID)
}

func (s *Service) RefreshToken(ctx context.Context, participantID uuid.UUID) (*JoinRoomOutput, error) {
	participant, err := s.db.GetParticipant(ctx, participantID)
	if err != nil {
		return nil, ErrParticipantNotFound
	}

	room, err := s.db.GetRoom(ctx, participant.RoomID)
	if err != nil {
		return nil, fmt.Errorf("room not found: %w", err)
	}

	cfParticipant, err := s.cfClient.RefreshParticipantToken(ctx, room.CloudflareMeetingID, participant.CloudflareParticipantID)
	if err != nil {
		return nil, fmt.Errorf("cloudflare token refresh failed: %w", err)
	}

	displayName := ""
	if participant.DisplayName != nil {
		displayName = *participant.DisplayName
	}

	tokenPair, err := s.tokenIssuer.GenerateTokenPair(auth.Claims{
		Subject:     participant.ID.String(),
		RoomID:      participant.RoomID,
		TenantID:    room.TenantID,
		DisplayName: displayName,
		Role:        participant.Role,
		CFAuthToken: cfParticipant.Token,
	})
	if err != nil {
		return nil, fmt.Errorf("token generation failed: %w", err)
	}

	return &JoinRoomOutput{
		ParticipantID: participant.ID,
		TokenPair:     tokenPair,
		CFAuthToken:   cfParticipant.Token,
		Room:          &room,
	}, nil
}

func strPtr(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
