package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/domain/participant"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/stretchr/testify/require"
)

type fakeJoinDB struct {
	delay time.Duration

	getRoomWithCountCalls  atomic.Int64
	getTenantCalls         atomic.Int64
	createParticipantCalls atomic.Int64

	roomID   uuid.UUID
	tenantID uuid.UUID
}

func (f *fakeJoinDB) GetRoomWithParticipantCount(ctx context.Context, id uuid.UUID) (db.GetRoomWithParticipantCountRow, error) {
	f.getRoomWithCountCalls.Add(1)
	time.Sleep(f.delay)
	f.roomID = id
	name := "Room"
	return db.GetRoomWithParticipantCountRow{
		ID:                     id,
		TenantID:               f.tenantID,
		CloudflareMeetingID:    "cf_meeting_1",
		Name:                   &name,
		Config:                 []byte(`{}`),
		Status:                 "active",
		StartedAt:              pgtype.Timestamptz{},
		EndedAt:                pgtype.Timestamptz{},
		CreatedAt:              time.Now(),
		UpdatedAt:              time.Now(),
		WhiteboardState:        []byte(`{}`),
		Metadata:               []byte(`{}`),
		ActiveParticipantCount: 0,
	}, nil
}

func (f *fakeJoinDB) GetTenant(ctx context.Context, id uuid.UUID) (db.Tenant, error) {
	f.getTenantCalls.Add(1)
	time.Sleep(f.delay)
	return db.Tenant{
		ID:                     id,
		Name:                   "Tenant",
		ApiKeyHash:             "hash",
		Config:                 []byte(`{}`),
		MaxConcurrentRooms:     999,
		MaxParticipantsPerRoom: 999,
		IsActive:               true,
		CreatedAt:              time.Now(),
		UpdatedAt:              time.Now(),
		TenantConfig:           []byte(`{"transcription_enabled":false,"first_participant_is_host":false,"force_recording":false,"allow_early_join":true}`),
		TenantKind:             "external",
	}, nil
}

func (f *fakeJoinDB) CreateParticipant(ctx context.Context, arg db.CreateParticipantParams) (db.Participant, error) {
	f.createParticipantCalls.Add(1)
	time.Sleep(f.delay)
	return db.Participant{
		ID:                      arg.ID,
		RoomID:                  arg.RoomID,
		CloudflareParticipantID: arg.CloudflareParticipantID,
		ExternalUserID:          arg.ExternalUserID,
		DisplayName:             arg.DisplayName,
		Role:                    arg.Role,
		JoinedAt:                pgtype.Timestamptz{Time: time.Now(), Valid: true},
		LeftAt:                  pgtype.Timestamptz{},
		CreatedAt:               time.Now(),
		Metadata:                arg.Metadata,
	}, nil
}

// Unused methods for this perf test. Keep explicit panics so regressions are loud.
func (f *fakeJoinDB) CountActiveParticipantsByRoom(ctx context.Context, roomID uuid.UUID) (int64, error) {
	panic("unexpected CountActiveParticipantsByRoom")
}
func (f *fakeJoinDB) ActivateScheduledRoom(ctx context.Context, id uuid.UUID) (db.Room, error) {
	panic("unexpected ActivateScheduledRoom")
}
func (f *fakeJoinDB) CreateRoomWithID(ctx context.Context, arg db.CreateRoomWithIDParams) (db.Room, error) {
	panic("unexpected CreateRoomWithID")
}
func (f *fakeJoinDB) GetActiveRecordingByRoom(ctx context.Context, roomID uuid.UUID) (db.Recording, error) {
	panic("unexpected GetActiveRecordingByRoom")
}
func (f *fakeJoinDB) GetParticipant(ctx context.Context, id uuid.UUID) (db.Participant, error) {
	panic("unexpected GetParticipant")
}
func (f *fakeJoinDB) GetParticipantByCloudflareID(ctx context.Context, cloudflareParticipantID string) (db.Participant, error) {
	panic("unexpected GetParticipantByCloudflareID")
}
func (f *fakeJoinDB) GetParticipantByExternalUserAndRoom(ctx context.Context, arg db.GetParticipantByExternalUserAndRoomParams) (db.Participant, error) {
	panic("unexpected GetParticipantByExternalUserAndRoom")
}
func (f *fakeJoinDB) GetRoom(ctx context.Context, id uuid.UUID) (db.Room, error) {
	panic("unexpected GetRoom")
}
func (f *fakeJoinDB) GetRoomHost(ctx context.Context, roomID uuid.UUID) (db.Participant, error) {
	panic("unexpected GetRoomHost")
}
func (f *fakeJoinDB) ListActiveParticipantsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.Participant, error) {
	panic("unexpected ListActiveParticipantsByRoom")
}
func (f *fakeJoinDB) ListParticipantsByRoom(ctx context.Context, roomID uuid.UUID) ([]db.Participant, error) {
	panic("unexpected ListParticipantsByRoom")
}
func (f *fakeJoinDB) ParticipantLeave(ctx context.Context, id uuid.UUID) (db.Participant, error) {
	panic("unexpected ParticipantLeave")
}
func (f *fakeJoinDB) ReactivateRoom(ctx context.Context, arg db.ReactivateRoomParams) (db.Room, error) {
	panic("unexpected ReactivateRoom")
}
func (f *fakeJoinDB) UpdateParticipant(ctx context.Context, arg db.UpdateParticipantParams) (db.Participant, error) {
	panic("unexpected UpdateParticipant")
}

type fakeCF struct {
	delay time.Duration
}

func (f *fakeCF) CreateMeeting(ctx context.Context, req cloudflare.CreateMeetingRequest) (*cloudflare.Meeting, error) {
	panic("unexpected CreateMeeting")
}
func (f *fakeCF) EndMeeting(ctx context.Context, meetingID string) (*cloudflare.Meeting, error) {
	panic("unexpected EndMeeting")
}
func (f *fakeCF) AddParticipant(ctx context.Context, meetingID string, req cloudflare.AddParticipantRequest) (*cloudflare.Participant, error) {
	time.Sleep(f.delay)
	return &cloudflare.Participant{ID: "cf_participant_1", Token: "cf_token_1"}, nil
}
func (f *fakeCF) RemoveParticipant(ctx context.Context, meetingID, participantID string) error {
	panic("unexpected RemoveParticipant")
}
func (f *fakeCF) RefreshParticipantToken(ctx context.Context, meetingID, participantID string) (*cloudflare.Participant, error) {
	panic("unexpected RefreshParticipantToken")
}

type fakeIssuer struct{}

func (f *fakeIssuer) GenerateTokenPair(claims auth.Claims) (*auth.TokenPair, error) {
	return &auth.TokenPair{
		AccessToken:  "access",
		RefreshToken: "refresh",
		TokenType:    "Bearer",
		ExpiresIn:    900,
	}, nil
}

func TestParticipantHandler_Add_Perf_JoinRoomBudget(t *testing.T) {
	// Goal: deterministic-ish regression guard for extra DB roundtrips in join.
	// We model per-call cost with small sleeps; adding extra queries should push above budget.
	router, claims := setupTestRouterWithClaims()
	claims.RoomID = uuid.Nil

	dbDelay := 20 * time.Millisecond
	cfDelay := 20 * time.Millisecond

	fdb := &fakeJoinDB{
		delay:    dbDelay,
		tenantID: claims.TenantID,
	}
	svc := participant.NewService(fdb, &fakeCF{delay: cfDelay}, nil, &fakeIssuer{}, nil, nil)

	handler := NewParticipantHandler(svc, nil, nil)
	router.POST("/rooms/:id/participants", handler.Add)

	body, err := json.Marshal(AddParticipantRequest{DisplayName: "Perf User", Role: "participant"})
	require.NoError(t, err)

	roomID := uuid.New()
	req := httptest.NewRequest("POST", "/rooms/"+roomID.String()+"/participants", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	start := time.Now()
	router.ServeHTTP(w, req)
	elapsed := time.Since(start)
	t.Logf("elapsed=%s", elapsed)

	require.Equal(t, http.StatusCreated, w.Code)

	require.Equal(t, int64(1), fdb.getRoomWithCountCalls.Load(), "expected single room+count query")
	require.Equal(t, int64(1), fdb.getTenantCalls.Load(), "expected single tenant query")
	require.Equal(t, int64(1), fdb.createParticipantCalls.Load(), "expected single create participant query")

	// Expected critical path: 3 DB calls + 1 CF call ~= 80ms. Budget gives room for CI jitter.
	require.Less(t, elapsed, 95*time.Millisecond, "join handler took too long (likely extra roundtrips)")
}
