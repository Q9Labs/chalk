package participant

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel/trace"
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

type JoinCache interface {
	Get(ctx context.Context, key string) (string, error)
	Set(ctx context.Context, key string, value interface{}, expiration time.Duration) error
}

type participantDB interface {
	ActivateScheduledRoom(ctx context.Context, id uuid.UUID) (db.Room, error)
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
	cache       JoinCache
}

func NewService(
	queries participantDB,
	cf CloudflareClient,
	roomState RoomStateManager,
	tokenIssuer TokenIssuer,
	hub WebSocketHub,
	cache JoinCache,
) *Service {
	return &Service{
		db:          queries,
		cfClient:    cf,
		roomState:   roomState,
		tokenIssuer: tokenIssuer,
		hub:         hub,
		cache:       cache,
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

const joinTenantCacheTTL = time.Minute

type cachedJoinTenant struct {
	TenantID               string          `json:"tenant_id"`
	MaxParticipantsPerRoom int32           `json:"max_participants_per_room"`
	TenantConfig           json.RawMessage `json:"tenant_config"`
}

func joinTenantCacheKey(tenantID uuid.UUID) string {
	return "join:tenant:v1:" + tenantID.String()
}

func (s *Service) getTenantForJoin(ctx context.Context, tenantID uuid.UUID) (db.Tenant, bool, error) {
	if s.cache != nil {
		cachedValue, err := s.cache.Get(ctx, joinTenantCacheKey(tenantID))
		if err == nil && cachedValue != "" {
			var cached cachedJoinTenant
			if unmarshalErr := json.Unmarshal([]byte(cachedValue), &cached); unmarshalErr == nil {
				cachedTenantID, parseErr := uuid.Parse(cached.TenantID)
				if parseErr == nil && cachedTenantID == tenantID {
					return db.Tenant{
						ID:                     cachedTenantID,
						MaxParticipantsPerRoom: cached.MaxParticipantsPerRoom,
						TenantConfig:           append([]byte(nil), cached.TenantConfig...),
					}, true, nil
				}
			}
		}
	}

	tenant, err := s.db.GetTenant(ctx, tenantID)
	if err != nil {
		return db.Tenant{}, false, err
	}
	s.setTenantForJoinCache(ctx, tenant)
	return tenant, false, nil
}

func (s *Service) setTenantForJoinCache(ctx context.Context, tenant db.Tenant) {
	if s.cache == nil {
		return
	}

	payload, err := json.Marshal(cachedJoinTenant{
		TenantID:               tenant.ID.String(),
		MaxParticipantsPerRoom: tenant.MaxParticipantsPerRoom,
		TenantConfig:           append([]byte(nil), tenant.TenantConfig...),
	})
	if err != nil {
		return
	}

	_ = s.cache.Set(ctx, joinTenantCacheKey(tenant.ID), string(payload), joinTenantCacheTTL)
}

func (s *Service) JoinRoom(ctx context.Context, input JoinRoomInput) (output *JoinRoomOutput, err error) {
	telemetry := newJoinRoomTelemetry()
	ctx = cloudflare.WithAttemptRecorder(ctx, telemetry)
	failedStep := ""
	defer func() {
		telemetry.log(ctx, input, failedStep, err)
	}()

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
			ID:                    r.ID,
			TenantID:              r.TenantID,
			CloudflareMeetingID:   r.CloudflareMeetingID,
			Name:                  r.Name,
			Config:                r.Config,
			Status:                r.Status,
			StartedAt:             r.StartedAt,
			EndedAt:               r.EndedAt,
			ScheduledStartAt:      r.ScheduledStartAt,
			ScheduledEndAt:        r.ScheduledEndAt,
			AllowEarlyJoinMinutes: r.AllowEarlyJoinMinutes,
			CreatedAt:             r.CreatedAt,
			UpdatedAt:             r.UpdatedAt,
			WhiteboardState:       r.WhiteboardState,
			Metadata:              r.Metadata,
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

	roomLookupStart := time.Now()
	roomRow, err := s.db.GetRoomWithParticipantCount(ctx, input.RoomID)
	telemetry.observeDB("db_get_room_with_participant_count", time.Since(roomLookupStart))
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			failedStep = "db_get_room_with_participant_count"
			return nil, fmt.Errorf("failed to fetch room: %w", err)
		}

		// Room doesn't exist - auto-create if tenant allows early join.
		if input.TenantID == uuid.Nil {
			return nil, ErrRoomNotAvailable
		}

		tenantLookupStart := time.Now()
		t, fromCache, err := s.getTenantForJoin(ctx, input.TenantID)
		if !fromCache {
			telemetry.observeDB("db_get_tenant_for_missing_room", time.Since(tenantLookupStart))
		}
		if err != nil {
			failedStep = "db_get_tenant_for_missing_room"
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
		createMeetingStart := time.Now()
		cfMeeting, err := s.cfClient.CreateMeeting(ctx, buildCreateMeetingReq(roomName, tenantCfg))
		telemetry.observeCloudflare("cf_create_meeting_for_missing_room", time.Since(createMeetingStart))
		if err != nil {
			failedStep = "cf_create_meeting_for_missing_room"
			return nil, fmt.Errorf("failed to create room: %w", err)
		}

		createRoomStart := time.Now()
		newRoom, err := s.db.CreateRoomWithID(ctx, db.CreateRoomWithIDParams{
			ID:                  input.RoomID,
			TenantID:            input.TenantID,
			CloudflareMeetingID: cfMeeting.ID,
			Name:                strPtr(roomName),
			Config:              []byte("{}"),
		})
		telemetry.observeDB("db_create_room_with_id", time.Since(createRoomStart))
		if err != nil {
			failedStep = "db_create_room_with_id"
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

		// Room exists and is scheduled - activate when join window opens.
		if room.Status == "scheduled" {
			if !room.ScheduledStartAt.Valid {
				return nil, ErrRoomNotAvailable
			}

			joinAllowedAt := room.ScheduledStartAt.Time.Add(-time.Duration(room.AllowEarlyJoinMinutes) * time.Minute)
			if time.Now().Before(joinAllowedAt) {
				return nil, ErrRoomNotAvailable
			}

			activateScheduledRoomStart := time.Now()
			room, err = s.db.ActivateScheduledRoom(ctx, input.RoomID)
			telemetry.observeDB("db_activate_scheduled_room", time.Since(activateScheduledRoomStart))
			if err != nil {
				if errors.Is(err, pgx.ErrNoRows) {
					refetchRoomStart := time.Now()
					refetchedRoom, refetchErr := s.db.GetRoom(ctx, input.RoomID)
					telemetry.observeDB("db_get_room_after_activate_race", time.Since(refetchRoomStart))
					if refetchErr == nil && refetchedRoom.Status == "active" {
						room = refetchedRoom
					} else {
						failedStep = "db_activate_scheduled_room"
						return nil, fmt.Errorf("failed to activate scheduled room: %w", err)
					}
				} else {
					failedStep = "db_activate_scheduled_room"
					return nil, fmt.Errorf("failed to activate scheduled room: %w", err)
				}
			}
			roomCreated = true
		}

		// Room exists but is ended - reactivate it.
		if room.Status == "ended" {
			tenantLookupStart := time.Now()
			t, fromCache, err := s.getTenantForJoin(ctx, room.TenantID)
			if !fromCache {
				telemetry.observeDB("db_get_tenant_for_ended_room", time.Since(tenantLookupStart))
			}
			if err != nil {
				failedStep = "db_get_tenant_for_ended_room"
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
			createMeetingStart := time.Now()
			cfMeeting, err := s.cfClient.CreateMeeting(ctx, buildCreateMeetingReq(roomName, tenantCfg))
			telemetry.observeCloudflare("cf_create_meeting_for_reactivation", time.Since(createMeetingStart))
			if err != nil {
				failedStep = "cf_create_meeting_for_reactivation"
				return nil, fmt.Errorf("failed to reactivate room: %w", err)
			}

			reactivateRoomStart := time.Now()
			room, err = s.db.ReactivateRoom(ctx, db.ReactivateRoomParams{
				ID:                  input.RoomID,
				CloudflareMeetingID: cfMeeting.ID,
			})
			telemetry.observeDB("db_reactivate_room", time.Since(reactivateRoomStart))
			if err != nil {
				failedStep = "db_reactivate_room"
				return nil, fmt.Errorf("failed to reactivate room in database: %w", err)
			}
			roomCreated = true // Room was reactivated (new CF meeting).
		}
	}

	if !tenantLoaded {
		tenantLookupStart := time.Now()
		t, fromCache, err := s.getTenantForJoin(ctx, room.TenantID)
		if !fromCache {
			telemetry.observeDB("db_get_tenant_for_existing_room", time.Since(tenantLookupStart))
		}
		if err != nil {
			failedStep = "db_get_tenant_for_existing_room"
			return nil, ErrTenantNotFound
		}
		tenant = t
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
		getExistingStart := time.Now()
		existing, err := s.db.GetParticipantByExternalUserAndRoom(ctx, db.GetParticipantByExternalUserAndRoomParams{
			RoomID:         input.RoomID,
			ExternalUserID: strPtr(input.ExternalUserID),
		})
		telemetry.observeDB("db_get_participant_by_external_user_and_room", time.Since(getExistingStart))
		if err == nil && !existing.LeftAt.Valid {
			refreshTokenStart := time.Now()
			cfParticipant, err := s.cfClient.RefreshParticipantToken(ctx, room.CloudflareMeetingID, existing.CloudflareParticipantID)
			telemetry.observeCloudflare("cf_refresh_participant_token", time.Since(refreshTokenStart))
			if err != nil {
				failedStep = "cf_refresh_participant_token"
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

	addParticipantStart := time.Now()
	cfParticipant, err := s.cfClient.AddParticipant(ctx, room.CloudflareMeetingID, cloudflare.AddParticipantRequest{
		Name:                 input.DisplayName,
		PresetName:           presetName,
		ClientSpecificID:     clientSpecificID,
		TranscriptionEnabled: false,
	})
	telemetry.observeCloudflare("cf_add_participant", time.Since(addParticipantStart))
	if err != nil {
		failedStep = "cf_add_participant"
		return nil, fmt.Errorf("cloudflare add participant failed: %w", err)
	}

	metadata := normalizeMetadata(input.Metadata)
	createParticipantStart := time.Now()
	participant, err := s.db.CreateParticipant(ctx, db.CreateParticipantParams{
		ID:                      participantID,
		RoomID:                  input.RoomID,
		CloudflareParticipantID: cfParticipant.ID,
		ExternalUserID:          strPtr(input.ExternalUserID),
		DisplayName:             strPtr(input.DisplayName),
		Role:                    role,
		Metadata:                metadata,
	})
	telemetry.observeDB("db_create_participant", time.Since(createParticipantStart))
	if err != nil {
		failedStep = "db_create_participant"
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
		getActiveRecordingStart := time.Now()
		_, recErr := s.db.GetActiveRecordingByRoom(ctx, input.RoomID)
		telemetry.observeDB("db_get_active_recording_by_room", time.Since(getActiveRecordingStart))
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

type joinRoomTelemetry struct {
	startedAt       time.Time
	dbTotal         time.Duration
	cloudflareTotal time.Duration
	stepDurations   map[string]time.Duration
	cloudflareOps   map[string]*joinCloudflareOperationTelemetry
}

type joinCloudflareOperationTelemetry struct {
	Attempts       int64  `json:"attempts"`
	Retries        int64  `json:"retries"`
	Timeouts       int64  `json:"timeouts"`
	LastStatusCode int    `json:"last_status_code"`
	Outcome        string `json:"outcome"`
}

func newJoinRoomTelemetry() *joinRoomTelemetry {
	return &joinRoomTelemetry{
		startedAt:     time.Now(),
		stepDurations: make(map[string]time.Duration),
		cloudflareOps: make(map[string]*joinCloudflareOperationTelemetry),
	}
}

func (t *joinRoomTelemetry) observeDB(step string, elapsed time.Duration) {
	t.dbTotal += elapsed
	t.stepDurations[step] += elapsed
}

func (t *joinRoomTelemetry) observeCloudflare(step string, elapsed time.Duration) {
	t.cloudflareTotal += elapsed
	t.stepDurations[step] += elapsed
}

func (t *joinRoomTelemetry) RecordCloudflareAttempt(event cloudflare.AttemptEvent) {
	if event.Operation == "" {
		return
	}
	stats, ok := t.cloudflareOps[event.Operation]
	if !ok {
		stats = &joinCloudflareOperationTelemetry{}
		t.cloudflareOps[event.Operation] = stats
	}
	stats.Attempts += 1
	if event.Retrying {
		stats.Retries += 1
	}
	if event.TimedOut {
		stats.Timeouts += 1
	}
	if event.StatusCode > 0 {
		stats.LastStatusCode = event.StatusCode
	}
	if event.Outcome != "" {
		stats.Outcome = event.Outcome
	}
}

func (t *joinRoomTelemetry) log(ctx context.Context, input JoinRoomInput, failedStep string, err error) {
	totalMs := time.Since(t.startedAt).Milliseconds()
	outcome := "success"
	if err != nil {
		outcome = "error"
	}

	traceID := ""
	spanCtx := trace.SpanContextFromContext(ctx)
	if spanCtx.IsValid() {
		traceID = spanCtx.TraceID().String()
	}

	attrs := []any{
		"event", "participant.join_room",
		"join_outcome", outcome,
		"room_id", input.RoomID.String(),
		"room_slug", normalizeRoomSlug(input.RoomName),
		"join_total_ms", totalMs,
		"join_db_total_ms", t.dbTotal.Milliseconds(),
		"join_cloudflare_total_ms", t.cloudflareTotal.Milliseconds(),
		"join_step_durations_ms", t.stepDurationsMs(),
		"join_cloudflare_step_durations_ms", t.prefixedStepDurationsMs("cf_"),
		"join_cloudflare_operations", t.cloudflareOperationStats(),
	}

	if input.TenantID != uuid.Nil {
		attrs = append(attrs, "tenant_id", input.TenantID.String())
	}

	requestID := firstNonEmpty(
		contextValueString(ctx, "request_id"),
		contextValueString(ctx, "chalk.request_id"),
	)
	if requestID != "" {
		attrs = append(attrs, "request_id", requestID)
	}
	if traceID != "" {
		attrs = append(attrs, "trace_id", traceID)
	}

	for step, duration := range t.stepDurations {
		attrs = append(attrs, step+"_ms", duration.Milliseconds())
	}

	if failedStep != "" {
		attrs = append(attrs, "failed_step", failedStep)
	}

	if err != nil {
		var cfErr *cloudflare.RequestError
		if errors.As(err, &cfErr) {
			retryCount := cfErr.Attempt - 1
			if retryCount < 0 {
				retryCount = 0
			}
			attrs = append(attrs,
				"cloudflare_operation", cfErr.Operation,
				"cloudflare_status", cfErr.Status,
				"cloudflare_attempt", cfErr.Attempt,
				"cloudflare_retry_count", retryCount,
				"cloudflare_timeout", isTimeoutError(cfErr.Err),
			)
		}
		attrs = append(attrs, "join_timeout", isTimeoutError(err))
		attrs = append(attrs, "error", err)
		slog.WarnContext(ctx, "participant join room failed", attrs...)
		return
	}

	slog.InfoContext(ctx, "participant join room succeeded", attrs...)
}

func (t *joinRoomTelemetry) stepDurationsMs() map[string]int64 {
	out := make(map[string]int64, len(t.stepDurations))
	for step, duration := range t.stepDurations {
		out[step] = duration.Milliseconds()
	}
	return out
}

func (t *joinRoomTelemetry) prefixedStepDurationsMs(prefix string) map[string]int64 {
	out := map[string]int64{}
	for step, duration := range t.stepDurations {
		if strings.HasPrefix(step, prefix) {
			out[step] = duration.Milliseconds()
		}
	}
	return out
}

func (t *joinRoomTelemetry) cloudflareOperationStats() map[string]joinCloudflareOperationTelemetry {
	out := make(map[string]joinCloudflareOperationTelemetry, len(t.cloudflareOps))
	for operation, stats := range t.cloudflareOps {
		if stats == nil {
			continue
		}
		out[operation] = *stats
	}
	return out
}

func normalizeRoomSlug(roomName string) string {
	normalized := strings.TrimSpace(roomName)
	if normalized == "" {
		return ""
	}
	return strings.ToLower(normalized)
}

func isTimeoutError(err error) bool {
	if err == nil {
		return false
	}
	return errors.Is(err, context.DeadlineExceeded)
}

func contextValueString(ctx context.Context, key any) string {
	value := ctx.Value(key)
	if value == nil {
		return ""
	}
	if str, ok := value.(string); ok {
		return str
	}
	if str, ok := value.(fmt.Stringer); ok {
		return str.String()
	}
	return fmt.Sprint(value)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
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

	// Update metadata in roomState and hub
	newDisplayName := ""
	if participant.DisplayName != nil {
		newDisplayName = *participant.DisplayName
	}

	meta := domain.ParticipantMetadata{
		DisplayName: newDisplayName,
		Role:        participant.Role,
		JoinedAt:    participant.CreatedAt,
	}
	if participant.JoinedAt.Valid {
		meta.JoinedAt = participant.JoinedAt.Time
	}

	if s.roomState != nil {
		_ = s.roomState.AddParticipant(ctx, participant.RoomID, participant.ID, meta)
	}

	if s.hub != nil {
		s.hub.SetParticipantMetadata(participant.ID, meta)

		msg, _ := json.Marshal(map[string]interface{}{
			"type": "participant.updated",
			"payload": map[string]interface{}{
				"participant_id": participant.ID,
				"changes": map[string]interface{}{
					"display_name": newDisplayName,
				},
			},
		})
		s.hub.BroadcastToRoom(participant.RoomID, msg, "")
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
