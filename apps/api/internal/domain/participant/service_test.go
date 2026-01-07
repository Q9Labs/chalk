package participant

import (
	"context"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/domain/auth"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
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
	addParticipantFn    func(ctx context.Context, roomID, participantID uuid.UUID, meta domain.ParticipantMetadata) error
	removeParticipantFn func(ctx context.Context, roomID, participantID uuid.UUID) error
	getParticipantsFn   func(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error)
}

func (m *mockRoomState) AddParticipant(ctx context.Context, roomID, participantID uuid.UUID, meta domain.ParticipantMetadata) error {
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

func (m *mockRoomState) GetParticipants(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error) {
	if m.getParticipantsFn != nil {
		return m.getParticipantsFn(ctx, roomID)
	}
	return make(map[uuid.UUID]domain.ParticipantMetadata), nil
}

type mockHub struct {
	setMetadataFn     func(participantID uuid.UUID, meta domain.ParticipantMetadata)
	removeMetadataFn  func(participantID uuid.UUID)
	getParticipantsIn func(roomID uuid.UUID) []uuid.UUID
	broadcastFn       func(roomID uuid.UUID, message []byte, excludeParticipantID string)
}

func (m *mockHub) SetParticipantMetadata(participantID uuid.UUID, meta domain.ParticipantMetadata) {
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

func (m *mockHub) BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	if m.broadcastFn != nil {
		m.broadcastFn(roomID, message, excludeParticipantID)
	}
}

type mockTokenIssuer struct {
	generateFn func(claims auth.Claims) (*auth.TokenPair, error)
}

func (m *mockTokenIssuer) GenerateTokenPair(claims auth.Claims) (*auth.TokenPair, error) {
	if m.generateFn != nil {
		return m.generateFn(claims)
	}
	return &auth.TokenPair{
		AccessToken:  "mock-access-token",
		RefreshToken: "mock-refresh-token",
		TokenType:    "Bearer",
		ExpiresIn:    900,
		ExpiresAt:    time.Now().Add(15 * time.Minute),
	}, nil
}

func TestNewService(t *testing.T) {
	cf := &mockCloudflareClient{}
	roomState := &mockRoomState{}
	tokenIssuer := &mockTokenIssuer{}
	hub := &mockHub{}

	svc := NewService(nil, cf, roomState, tokenIssuer, hub)

	if svc == nil {
		t.Fatal("expected service to be non-nil")
	}
	if svc.cfClient == nil {
		t.Error("expected cloudflare client to be set")
	}
	if svc.tokenIssuer == nil {
		t.Error("expected token issuer to be set")
	}
}

func TestJoinRoomInput(t *testing.T) {
	roomID := uuid.New()
	input := JoinRoomInput{
		RoomID:         roomID,
		DisplayName:    "Test User",
		ExternalUserID: "ext-123",
		Role:           "participant",
	}

	if input.RoomID != roomID {
		t.Error("expected room ID to match")
	}
	if input.DisplayName != "Test User" {
		t.Error("expected display name to match")
	}
}

func TestJoinRoomOutput(t *testing.T) {
	participantID := uuid.New()
	output := JoinRoomOutput{
		ParticipantID: participantID,
		TokenPair: &auth.TokenPair{
			AccessToken: "test-token",
		},
		CFAuthToken: "cf-token",
	}

	if output.ParticipantID != participantID {
		t.Error("expected participant ID to match")
	}
	if output.TokenPair.AccessToken != "test-token" {
		t.Error("expected token to match")
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

func TestErrorTypes(t *testing.T) {
	if ErrRoomNotAvailable.Error() != "room not available" {
		t.Error("expected correct error message for ErrRoomNotAvailable")
	}
	if ErrRoomFull.Error() != "room is full" {
		t.Error("expected correct error message for ErrRoomFull")
	}
	if ErrParticipantNotFound.Error() != "participant not found" {
		t.Error("expected correct error message for ErrParticipantNotFound")
	}
}
