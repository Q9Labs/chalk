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
	"github.com/jackc/pgx/v5"
)

var (
	ErrRoomNotAvailable    = errors.New("room not available")
	ErrRoomNotFound        = errors.New("room not found")
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

type participantDB interface {
	CountActiveParticipantsByRoom(ctx context.Context, roomID uuid.UUID) (int64, error)
	CreateParticipant(ctx context.Context, arg db.CreateParticipantParams) (db.Participant, error)
	CreateRoomWithID(ctx context.Context, arg db.CreateRoomWithIDParams) (db.Room, error)
	GetActiveRecordingByRoom(ctx context.Context, roomID uuid.UUID) (db.Recording, error)
	GetParticipant(ctx context.Context, id uuid.UUID) (db.Participant, error)
	GetParticipantByCloudflareID(ctx context.Context, cloudflareParticipantID string) (db.Participant, error)
	GetParticipantByExternalUserAndRoom(ctx context.Context, arg db.GetParticipantByExternalUserAndRoomParams) (db.Participant, error)
	GetRoom(ctx context.Context, id uuid.UUID) (db.Room, error)
	GetRoomHost(ctx context.Context, roomID uuid.UUID) (db.Participant, error)
	GetRoomWithParticipantCount(ctx context.Context, id uuid.UUID) (db.GetRoomWithParticipantCountRow, error)
	GetTenant(ctx context.Context, id uuid.UUID) (db.Tenant, error)
	ListActiveParticipantsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.Participant, error)
	ListParticipantsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.Participant, error)
	ParticipantLeave(ctx context.Context, id uuid.UUID) (db.Participant, error)
	ReactivateRoom(ctx context.Context, arg db.ReactivateRoomParams) (db.Room, error)
	UpdateParticipant(ctx context.Context, arg db.UpdateParticipantParams) (db.Participant, error)
}

type Service struct {
	db          participantDB
	cfClient    CloudflareClient
	roomState   RoomStateManager
	tokenIssuer TokenIssuer
	hub         WebSocketHub
}

func NewService(queries participantDB, cf CloudflareClient, roomState RoomStateManager, tokenIssuer TokenIssuer, hub WebSocketHub) *Service {
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
	Metadata       json.RawMessage
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
	Participant          *db.Participant
	TokenPair            *auth.TokenPair
	CFAuthToken          string
	Room                 *db.Room
	RoomCreated          bool               // True if room was just created (not pre-existing)
	TenantConfig         TenantConfigOutput // Tenant configuration for this room
	ShouldStartRecording bool               // True if tenant has force_recording and this is first host
}

func (s *Service) JoinRoom(ctx context.Context, input JoinRoomInput) (*JoinRoomOutput, error) {
	type tenantJoinConfig struct {
		AllowEarlyJoin               bool     `json:"allow_early_join"`
		TranscriptionEnabled         bool     `json:"transcription_enabled"`
		TranscriptionLanguage        string   `json:"transcription_language"`
		TranscriptionProfanityFilter bool     `json:"transcription_profanity_filter"`
		TranscriptionKeywords        []string `json:"transcription_keywords"`
		FirstParticipantIsHost       bool     `json:"first_participant_is_host"`
		ForceRecording               bool     `json:"force_recording"`
	}

	parseTenantConfig := func(raw []byte) tenantJoinConfig {
		var cfg tenantJoinConfig
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &cfg)
		}
		return cfg
	}

	buildCreateMeetingReq := func(title string, cfg tenantJoinConfig) cloudflare.CreateMeetingRequest {
		if title == "" {
			title = "Auto-created Room"
		}
		req := cloudflare.CreateMeetingRequest{Title: title}
		if !cfg.TranscriptionEnabled {
			return req
		}
		lang := cfg.TranscriptionLanguage
		if lang == "" {
			lang = "en-US"
		}
		req.AIConfig = &cloudflare.AIConfig{
			Transcription: &cloudflare.TranscriptionConfig{
				Language:        lang,
				ProfanityFilter: cfg.TranscriptionProfanityFilter,
				Keywords:        cfg.TranscriptionKeywords,
			},
		}
		return req
	}

	roomFromCountRow := func(r db.GetRoomWithParticipantCountRow) db.Room {
		return db.Room{
			ID:                  r.ID,
			TenantID:            r.TenantID,
			CloudflareMeetingID: r.CloudflareMeetingID,
			Name:                r.Name,
			Config:              r.Config,
			Status:              r.Status,
			StartedAt:           r.StartedAt,
			EndedAt:             r.EndedAt,
			CreatedAt:           r.CreatedAt,
			UpdatedAt:           r.UpdatedAt,
			WhiteboardState:     r.WhiteboardState,
			Metadata:            r.Metadata,
		}
	}

	var (
		room                    db.Room
		roomCreated             bool
		activeParticipantsCount int64

		tenant       db.Tenant
		tenantLoaded bool
		tenantCfg    tenantJoinConfig
	)

	roomRow, err := s.db.GetRoomWithParticipantCount(ctx, input.RoomID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("failed to fetch room: %w", err)
		}

		// Room doesn't exist - auto-create if tenant allows early join.
		if input.TenantID == uuid.Nil {
			return nil, ErrRoomNotAvailable
		}

		t, err := s.db.GetTenant(ctx, input.TenantID)
		if err != nil {
			return nil, ErrTenantNotFound
		}
		tenant = t
		tenantLoaded = true
		if tenant.TenantConfig != nil {
			tenantCfg = parseTenantConfig(tenant.TenantConfig)
		}

		if !tenantCfg.AllowEarlyJoin {
			return nil, ErrRoomNotAvailable
		}

		roomName := input.RoomName
		cfMeeting, err := s.cfClient.CreateMeeting(ctx, buildCreateMeetingReq(roomName, tenantCfg))
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
		activeParticipantsCount = 0
	} else {
		room = roomFromCountRow(roomRow)
		activeParticipantsCount = roomRow.ActiveParticipantCount

		// Security: if a room exists but belongs to another tenant, act like it's missing.
		if input.TenantID != uuid.Nil && room.TenantID != input.TenantID {
			return nil, ErrRoomNotFound
		}

		// Room exists but is ended - reactivate it.
		if room.Status != "active" {
			t, err := s.db.GetTenant(ctx, room.TenantID)
			if err != nil {
				return nil, ErrTenantNotFound
			}
			tenant = t
			tenantLoaded = true
			if tenant.TenantConfig != nil {
				tenantCfg = parseTenantConfig(tenant.TenantConfig)
			}

			if !tenantCfg.AllowEarlyJoin {
				return nil, ErrRoomNotAvailable
			}

			roomName := ""
			if room.Name != nil {
				roomName = *room.Name
			}
			cfMeeting, err := s.cfClient.CreateMeeting(ctx, buildCreateMeetingReq(roomName, tenantCfg))
			if err != nil {
				return nil, fmt.Errorf("failed to reactivate room: %w", err)
			}

			room, err = s.db.ReactivateRoom(ctx, db.ReactivateRoomParams{
				ID:                  input.RoomID,
				CloudflareMeetingID: cfMeeting.ID,
			})
			if err != nil {
				return nil, fmt.Errorf("failed to reactivate room in database: %w", err)
			}
			roomCreated = true // Room was reactivated (new CF meeting).
		}
	}

	if !tenantLoaded {
		t, err := s.db.GetTenant(ctx, room.TenantID)
		if err != nil {
			return nil, ErrTenantNotFound
		}
		tenant = t
		tenantLoaded = true
		if tenant.TenantConfig != nil {
			tenantCfg = parseTenantConfig(tenant.TenantConfig)
		}
	}

	if activeParticipantsCount >= int64(tenant.MaxParticipantsPerRoom) {
		return nil, ErrRoomFull
	}

	presetName := cloudflare.PresetParticipant
	if input.Role == "host" {
		presetName = cloudflare.PresetHost
	}

	// Stable identity across WS + RTK: use DB participant UUID as Cloudflare client_specific_id.
	// This makes RTK participant.userId match our canonical participant ID.
	participantID := uuid.New()
	clientSpecificID := participantID.String()

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

	// Check for existing active participant (multi-device support).
	// If found and still active (hasn't left), return existing with refreshed token.
	if input.ExternalUserID != "" {
		existing, err := s.db.GetParticipantByExternalUserAndRoom(ctx, db.GetParticipantByExternalUserAndRoomParams{
			RoomID:         input.RoomID,
			ExternalUserID: strPtr(input.ExternalUserID),
		})
		if err == nil && !existing.LeftAt.Valid {
			cfParticipant, err := s.cfClient.RefreshParticipantToken(ctx, room.CloudflareMeetingID, existing.CloudflareParticipantID)
			if err != nil {
				return nil, fmt.Errorf("cloudflare token refresh failed: %w", err)
			}

			displayName := ""
			if existing.DisplayName != nil {
				displayName = *existing.DisplayName
			}

			tokenPair, err := s.tokenIssuer.GenerateTokenPair(auth.Claims{
				Subject:     existing.ID.String(),
				RoomID:      existing.RoomID,
				TenantID:    room.TenantID,
				DisplayName: displayName,
				Role:        existing.Role,
				CFAuthToken: cfParticipant.Token,
			})
			if err != nil {
				return nil, fmt.Errorf("token generation failed: %w", err)
			}

			return &JoinRoomOutput{
				ParticipantID:        existing.ID,
				Participant:          &existing,
				TokenPair:            tokenPair,
				CFAuthToken:          cfParticipant.Token,
				Room:                 &room,
				RoomCreated:          false,
				TenantConfig:         tenantConfigOutput,
				ShouldStartRecording: false,
			}, nil
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

	metadata := normalizeMetadata(input.Metadata)
	participant, err := s.db.CreateParticipant(ctx, db.CreateParticipantParams{
		ID:                      participantID,
		RoomID:                  input.RoomID,
		CloudflareParticipantID: cfParticipant.ID,
		ExternalUserID:          strPtr(input.ExternalUserID),
		DisplayName:             strPtr(input.DisplayName),
		Role:                    role,
		Metadata:                metadata,
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
		Participant:          &participant,
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
		Participant:   &participant,
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

func normalizeMetadata(raw json.RawMessage) []byte {
	if len(raw) == 0 {
		return []byte(`{}`)
	}
	if json.Valid(raw) {
		return raw
	}
	return []byte(`{}`)
}
