package participant

import (
	"context"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/redis"
	"github.com/google/uuid"
)

type mockCloudflareClient struct {
	addParticipantFn        func(ctx context.Context, meetingID string, req cloudflare.AddParticipantRequest) (*cloudflare.Participant, error)
	removeParticipantFn     func(ctx context.Context, meetingID, participantID string) error
	refreshParticipantToken func(ctx context.Context, meetingID, participantID string) (*cloudflare.Participant, error)
}

func (m *mockCloudflareClient) AddParticipant(ctx context.Context, meetingID string, req cloudflare.AddParticipantRequest) (*cloudflare.Participant, error) {
	if m.addParticipantFn != nil {
		return m.addParticipantFn(ctx, meetingID, req)
	}
	return &cloudflare.Participant{
		ID:    "cf-participant-123",
		Name:  req.Name,
		Token: "cf-token-abc",
	}, nil
}

func (m *mockCloudflareClient) RemoveParticipant(ctx context.Context, meetingID, participantID string) error {
	if m.removeParticipantFn != nil {
		return m.removeParticipantFn(ctx, meetingID, participantID)
	}
	return nil
}

func (m *mockCloudflareClient) RefreshParticipantToken(ctx context.Context, meetingID, participantID string) (*cloudflare.Participant, error) {
	if m.refreshParticipantToken != nil {
		return m.refreshParticipantToken(ctx, meetingID, participantID)
	}
	return &cloudflare.Participant{
		ID:    participantID,
		Token: "cf-refreshed-token",
	}, nil
}

type mockRoomState struct {
	addParticipantFn    func(ctx context.Context, roomID, participantID uuid.UUID, meta redis.ParticipantMetadata) error
	removeParticipantFn func(ctx context.Context, roomID, participantID uuid.UUID) error
	getParticipantsFn   func(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]redis.ParticipantMetadata, error)
}

func (m *mockRoomState) AddParticipant(ctx context.Context, roomID, participantID uuid.UUID, meta redis.ParticipantMetadata) error {
	if m.addParticipantFn != nil {
		return m.addParticipantFn(ctx, roomID, participantID, meta)
	}
	return nil
}

func (m *mockRoomState) RemoveParticipant(ctx context.Context, roomID, participantID uuid.UUID) error {
	if m.removeParticipantFn != nil {
		return m.removeParticipantFn(ctx, roomID, participantID)
	}
	return nil
}

func (m *mockRoomState) GetParticipants(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]redis.ParticipantMetadata, error) {
	if m.getParticipantsFn != nil {
		return m.getParticipantsFn(ctx, roomID)
	}
	return make(map[uuid.UUID]redis.ParticipantMetadata), nil
}

type mockHub struct {
	setMetadataFn     func(participantID uuid.UUID, meta ParticipantMetadata)
	removeMetadataFn  func(participantID uuid.UUID)
	getParticipantsIn func(roomID uuid.UUID) []uuid.UUID
}

func (m *mockHub) SetParticipantMetadata(participantID uuid.UUID, meta ParticipantMetadata) {
	if m.setMetadataFn != nil {
		m.setMetadataFn(participantID, meta)
	}
}

func (m *mockHub) RemoveParticipantMetadata(participantID uuid.UUID) {
	if m.removeMetadataFn != nil {
		m.removeMetadataFn(participantID)
	}
}

func (m *mockHub) GetParticipantsInRoom(roomID uuid.UUID) []uuid.UUID {
	if m.getParticipantsIn != nil {
		return m.getParticipantsIn(roomID)
	}
	return []uuid.UUID{}
}

type mockJWTService struct {
	generateAccessTokenFn func(claims auth.Claims) (string, error)
}

func (m *mockJWTService) GenerateAccessToken(claims auth.Claims) (string, error) {
	if m.generateAccessTokenFn != nil {
		return m.generateAccessTokenFn(claims)
	}
	return "mock-jwt-token", nil
}

func TestNewService(t *testing.T) {
	cf := &mockCloudflareClient{}
	roomState := &mockRoomState{}
	jwt := &mockJWTService{}
	hub := &mockHub{}

	svc := NewService(nil, cf, roomState, jwt, hub)

	if svc == nil {
		t.Fatal("expected service to be non-nil")
	}
	if svc.cfClient != cf {
		t.Error("expected cloudflare client to be set")
	}
	if svc.roomState != roomState {
		t.Error("expected room state to be set")
	}
	if svc.jwtService != jwt {
		t.Error("expected jwt service to be set")
	}
	if svc.hub != hub {
		t.Error("expected hub to be set")
	}
}

func TestJoinRoomInput(t *testing.T) {
	roomID := uuid.New()
	input := JoinRoomInput{
		RoomID:         roomID,
		DisplayName:    "John Doe",
		ExternalUserID: "ext-123",
		Role:           "host",
	}

	if input.RoomID != roomID {
		t.Error("expected room ID to match")
	}
	if input.DisplayName != "John Doe" {
		t.Error("expected display name to match")
	}
	if input.Role != "host" {
		t.Error("expected role to be host")
	}
}

func TestJoinRoomOutput(t *testing.T) {
	participantID := uuid.New()
	output := JoinRoomOutput{
		ParticipantID: participantID,
		Token:         "jwt-token",
		CFAuthToken:   "cf-auth-token",
	}

	if output.ParticipantID != participantID {
		t.Error("expected participant ID to match")
	}
	if output.Token != "jwt-token" {
		t.Error("expected token to match")
	}
	if output.CFAuthToken != "cf-auth-token" {
		t.Error("expected CF auth token to match")
	}
}

func TestParticipantMetadata(t *testing.T) {
	now := time.Now()
	meta := ParticipantMetadata{
		DisplayName: "Test User",
		Role:        "participant",
		JoinedAt:    now,
	}

	if meta.DisplayName != "Test User" {
		t.Error("expected display name to match")
	}
	if meta.Role != "participant" {
		t.Error("expected role to match")
	}
	if meta.JoinedAt != now {
		t.Error("expected joined at to match")
	}
}

func TestStrPtr(t *testing.T) {
	result := strPtr("test")
	if result == nil || *result != "test" {
		t.Error("expected pointer to string 'test'")
	}

	nilResult := strPtr("")
	if nilResult != nil {
		t.Error("expected nil for empty string")
	}
}

func TestErrors(t *testing.T) {
	if ErrRoomNotAvailable.Error() != "room not available" {
		t.Error("unexpected error message for ErrRoomNotAvailable")
	}
	if ErrRoomFull.Error() != "room is full" {
		t.Error("unexpected error message for ErrRoomFull")
	}
	if ErrParticipantNotFound.Error() != "participant not found" {
		t.Error("unexpected error message for ErrParticipantNotFound")
	}
}
