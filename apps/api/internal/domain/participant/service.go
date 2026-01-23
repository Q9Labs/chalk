package participant

import (
	"context"
	"encoding/json"
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
	CreateMeeting(ctx context.Context, req cloudflare.CreateMeetingRequest) (*cloudflare.Meeting, error)
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
	RoomName       string    // Room name - used for auto-creating rooms
	TenantID       uuid.UUID // From JWT - used for auto-creating rooms
	DisplayName    string
	ExternalUserID string
	Role           string
}

// TenantConfigOutput contains tenant configuration relevant to the room
type TenantConfigOutput struct {
	TranscriptionEnabled   bool `json:"transcription_enabled"`
	FirstParticipantIsHost bool `json:"first_participant_is_host"`
	ForceRecording         bool `json:"force_recording"`
	AllowEarlyJoin         bool `json:"allow_early_join"`
}

type JoinRoomOutput struct {
	ParticipantID        uuid.UUID
	TokenPair            *auth.TokenPair
	CFAuthToken          string
	Room                 *db.Room
	RoomCreated          bool              // True if room was just created (not pre-existing)
	TenantConfig         TenantConfigOutput // Tenant configuration for this room
	ShouldStartRecording bool              // True if tenant has force_recording and this is first host
}

func (s *Service) JoinRoom(ctx context.Context, input JoinRoomInput) (*JoinRoomOutput, error) {
	room, err := s.db.GetRoom(ctx, input.RoomID)
	roomCreated := false

	// Room doesn't exist - auto-create if tenant allows early join
	if err != nil {
		if input.TenantID == uuid.Nil {
			return nil, ErrRoomNotAvailable
		}

		tenant, err := s.db.GetTenant(ctx, input.TenantID)
		if err != nil {
			return nil, ErrTenantNotFound
		}

		// Check if tenant allows early join (auto-creation) and get transcription config
		var tenantConfig struct {
			AllowEarlyJoin               bool     `json:"allow_early_join"`
			TranscriptionEnabled         bool     `json:"transcription_enabled"`
			TranscriptionLanguage        string   `json:"transcription_language"`
			TranscriptionProfanityFilter bool     `json:"transcription_profanity_filter"`
			TranscriptionKeywords        []string `json:"transcription_keywords"`
		}
		if tenant.TenantConfig != nil {
			_ = json.Unmarshal(tenant.TenantConfig, &tenantConfig)
		}

		if !tenantConfig.AllowEarlyJoin {
			return nil, ErrRoomNotAvailable
		}

		// Auto-create the room
		roomName := input.RoomName
		if roomName == "" {
			roomName = "Auto-created Room"
		}

		cfReq := cloudflare.CreateMeetingRequest{Title: roomName}
		if tenantConfig.TranscriptionEnabled {
			lang := tenantConfig.TranscriptionLanguage
			if lang == "" {
				lang = "en-US"
			}
			cfReq.AIConfig = &cloudflare.AIConfig{
				Transcription: &cloudflare.TranscriptionConfig{
					Language:        lang,
					ProfanityFilter: tenantConfig.TranscriptionProfanityFilter,
					Keywords:        tenantConfig.TranscriptionKeywords,
				},
			}
		}

		cfMeeting, err := s.cfClient.CreateMeeting(ctx, cfReq)
		if err != nil {
			return nil, fmt.Errorf("failed to create room: %w", err)
		}

		newRoom, err := s.db.CreateRoomWithID(ctx, db.CreateRoomWithIDParams{
			ID:                  input.RoomID,
			TenantID:            input.TenantID,
			CloudflareMeetingID: cfMeeting.ID,
			Name:                strPtr(roomName),
			Config:              []byte("{}"),
		})
		if err != nil {
			return nil, fmt.Errorf("failed to create room in database: %w", err)
		}
		room = newRoom
		roomCreated = true
	}

	// Room exists but is ended - reactivate it
	if room.Status != "active" {
		tenant, err := s.db.GetTenant(ctx, room.TenantID)
		if err != nil {
			return nil, ErrTenantNotFound
		}

		// Check if tenant allows early join (reactivation) and get transcription config
		var tenantConfig struct {
			AllowEarlyJoin               bool     `json:"allow_early_join"`
			TranscriptionEnabled         bool     `json:"transcription_enabled"`
			TranscriptionLanguage        string   `json:"transcription_language"`
			TranscriptionProfanityFilter bool     `json:"transcription_profanity_filter"`
			TranscriptionKeywords        []string `json:"transcription_keywords"`
		}
		if tenant.TenantConfig != nil {
			_ = json.Unmarshal(tenant.TenantConfig, &tenantConfig)
		}

		if !tenantConfig.AllowEarlyJoin {
			return nil, ErrRoomNotAvailable
		}

		// Create new Cloudflare meeting for the reactivated room
		roomName := ""
		if room.Name != nil {
			roomName = *room.Name
		}
		cfReq := cloudflare.CreateMeetingRequest{Title: roomName}
		if tenantConfig.TranscriptionEnabled {
			lang := tenantConfig.TranscriptionLanguage
			if lang == "" {
				lang = "en-US"
			}
			cfReq.AIConfig = &cloudflare.AIConfig{
				Transcription: &cloudflare.TranscriptionConfig{
					Language:        lang,
					ProfanityFilter: tenantConfig.TranscriptionProfanityFilter,
					Keywords:        tenantConfig.TranscriptionKeywords,
				},
			}
		}
		cfMeeting, err := s.cfClient.CreateMeeting(ctx, cfReq)
		if err != nil {
			return nil, fmt.Errorf("failed to reactivate room: %w", err)
		}

		// Reactivate room in database with new CF meeting ID
		room, err = s.db.ReactivateRoom(ctx, db.ReactivateRoomParams{
			ID:                  input.RoomID,
			CloudflareMeetingID: cfMeeting.ID,
		})
		if err != nil {
			return nil, fmt.Errorf("failed to reactivate room in database: %w", err)
		}
		roomCreated = true // Room was reactivated (new CF meeting)
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

	// Check for existing active participant (multi-device support)
	if input.ExternalUserID != "" {
		existing, err := s.db.GetParticipantByExternalUserAndRoom(ctx, db.GetParticipantByExternalUserAndRoomParams{
			RoomID:         input.RoomID,
			ExternalUserID: strPtr(input.ExternalUserID),
		})
		// If found and still active (hasn't left), return existing with refreshed token
		if err == nil && !existing.LeftAt.Valid {
			return s.RefreshToken(ctx, existing.ID)
		}
	}

	presetName := cloudflare.PresetParticipant
	if input.Role == "host" {
		presetName = cloudflare.PresetHost
	}

	// Generate a participant ID if none provided (Cloudflare requires client_specific_id)
	clientSpecificID := input.ExternalUserID
	if clientSpecificID == "" {
		clientSpecificID = uuid.New().String()
	}

	// Parse tenant config for all relevant settings
	var tenantCfg struct {
		TranscriptionEnabled   bool `json:"transcription_enabled"`
		FirstParticipantIsHost bool `json:"first_participant_is_host"`
		ForceRecording         bool `json:"force_recording"`
		AllowEarlyJoin         bool `json:"allow_early_join"`
	}
	if tenant.TenantConfig != nil {
		_ = json.Unmarshal(tenant.TenantConfig, &tenantCfg)
	}

	// Build tenant config output for response
	tenantConfigOutput := TenantConfigOutput{
		TranscriptionEnabled:   tenantCfg.TranscriptionEnabled,
		FirstParticipantIsHost: tenantCfg.FirstParticipantIsHost,
		ForceRecording:         tenantCfg.ForceRecording,
		AllowEarlyJoin:         tenantCfg.AllowEarlyJoin,
	}

	// Determine role - first participant becomes host if tenant config allows
	role := input.Role
	if role == "" {
		if tenantCfg.FirstParticipantIsHost && activeParticipantsCount == 0 {
			role = "host"
			presetName = cloudflare.PresetHost
		} else {
			role = "participant"
		}
	}

	cfParticipant, err := s.cfClient.AddParticipant(ctx, room.CloudflareMeetingID, cloudflare.AddParticipantRequest{
		Name:                 input.DisplayName,
		PresetName:           presetName,
		ClientSpecificID:     clientSpecificID,
		TranscriptionEnabled: tenantCfg.TranscriptionEnabled,
	})
	if err != nil {
		return nil, fmt.Errorf("cloudflare add participant failed: %w", err)
	}

	participant, err := s.db.CreateParticipant(ctx, db.CreateParticipantParams{
		RoomID:                  input.RoomID,
		CloudflareParticipantID: cfParticipant.ID,
		ExternalUserID:          strPtr(clientSpecificID),
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

	// Broadcast participant.joined to room
	if s.hub != nil {
		msg, _ := json.Marshal(map[string]interface{}{
			"event": "participant.joined",
			"data": map[string]interface{}{
				"participant_id": participant.ID,
				"room_id":        input.RoomID,
				"display_name":   input.DisplayName,
				"role":           role,
			},
		})
		s.hub.BroadcastToRoom(input.RoomID, msg, participant.ID.String())
	}

	// Check if force recording should trigger
	shouldStartRecording := false
	if role == "host" && tenantCfg.ForceRecording {
		// Check if no active recording
		_, recErr := s.db.GetActiveRecordingByRoom(ctx, input.RoomID)
		if recErr != nil { // No active recording
			shouldStartRecording = true
		}
	}

	return &JoinRoomOutput{
		ParticipantID:        participant.ID,
		TokenPair:            tokenPair,
		CFAuthToken:          cfParticipant.Token,
		Room:                 &room,
		RoomCreated:          roomCreated,
		TenantConfig:         tenantConfigOutput,
		ShouldStartRecording: shouldStartRecording,
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

		// Broadcast participant.left to room
		msg, _ := json.Marshal(map[string]interface{}{
			"event": "participant.left",
			"data": map[string]interface{}{
				"participant_id": participantID,
				"room_id":        roomID,
			},
		})
		s.hub.BroadcastToRoom(roomID, msg, "")
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
