package room

import (
	"context"
	"testing"

	"github.com/Q9Labs/chalk/internal/domain"
	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/Q9Labs/chalk/internal/infrastructure/postgres/db"
	"github.com/google/uuid"
)

type mockCloudflareClient struct {
	createMeetingFn func(ctx context.Context, req cloudflare.CreateMeetingRequest) (*cloudflare.Meeting, error)
	getMeetingFn    func(ctx context.Context, meetingID string) (*cloudflare.Meeting, error)
	endMeetingFn    func(ctx context.Context, meetingID string) (*cloudflare.Meeting, error)
}

func (m *mockCloudflareClient) CreateMeeting(ctx context.Context, req cloudflare.CreateMeetingRequest) (*cloudflare.Meeting, error) {
	if m.createMeetingFn != nil {
		return m.createMeetingFn(ctx, req)
	}
	return &cloudflare.Meeting{ID: "cf-meeting-123"}, nil
}

func (m *mockCloudflareClient) GetMeeting(ctx context.Context, meetingID string) (*cloudflare.Meeting, error) {
	if m.getMeetingFn != nil {
		return m.getMeetingFn(ctx, meetingID)
	}
	return &cloudflare.Meeting{ID: meetingID}, nil
}

func (m *mockCloudflareClient) EndMeeting(ctx context.Context, meetingID string) (*cloudflare.Meeting, error) {
	if m.endMeetingFn != nil {
		return m.endMeetingFn(ctx, meetingID)
	}
	return &cloudflare.Meeting{ID: meetingID, Status: "ENDED"}, nil
}

type mockRoomState struct {
	clearRoomFn         func(ctx context.Context, roomID uuid.UUID) error
	getParticipantsFn   func(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error)
	setRecordingStateFn func(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error
	getRecordingStateFn func(ctx context.Context, roomID uuid.UUID) (*domain.RecordingState, error)
}

func (m *mockRoomState) ClearRoom(ctx context.Context, roomID uuid.UUID) error {
	if m.clearRoomFn != nil {
		return m.clearRoomFn(ctx, roomID)
	}
	return nil
}

func (m *mockRoomState) GetParticipants(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error) {
	if m.getParticipantsFn != nil {
		return m.getParticipantsFn(ctx, roomID)
	}
	return make(map[uuid.UUID]domain.ParticipantMetadata), nil
}

func (m *mockRoomState) SetRecordingState(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error {
	if m.setRecordingStateFn != nil {
		return m.setRecordingStateFn(ctx, roomID, isRecording, recordingID)
	}
	return nil
}

func (m *mockRoomState) GetRecordingState(ctx context.Context, roomID uuid.UUID) (*domain.RecordingState, error) {
	if m.getRecordingStateFn != nil {
		return m.getRecordingStateFn(ctx, roomID)
	}
	return &domain.RecordingState{IsRecording: false}, nil
}

type mockHub struct {
	broadcastFn           func(roomID uuid.UUID, message []byte, excludeParticipantID string)
	getParticipantsInRoom func(roomID uuid.UUID) []uuid.UUID
	setRoomRecordingState func(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID)
}

func (m *mockHub) BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	if m.broadcastFn != nil {
		m.broadcastFn(roomID, message, excludeParticipantID)
	}
}

func (m *mockHub) GetParticipantsInRoom(roomID uuid.UUID) []uuid.UUID {
	if m.getParticipantsInRoom != nil {
		return m.getParticipantsInRoom(roomID)
	}
	return []uuid.UUID{}
}

func (m *mockHub) SetRoomRecordingState(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) {
	if m.setRoomRecordingState != nil {
		m.setRoomRecordingState(roomID, isRecording, recordingID)
	}
}

func TestNewService(t *testing.T) {
	cf := &mockCloudflareClient{}
	roomState := &mockRoomState{}
	hub := &mockHub{}

	svc := NewService(nil, cf, roomState, hub)

	if svc == nil {
		t.Fatal("expected service to be non-nil")
	}
	if svc.cfClient != cf {
		t.Error("expected cloudflare client to be set")
	}
	if svc.roomState != roomState {
		t.Error("expected room state to be set")
	}
	if svc.hub != hub {
		t.Error("expected hub to be set")
	}
}

func TestCreateRoomInput(t *testing.T) {
	tenantID := uuid.New()
	input := CreateRoomInput{
		TenantID: tenantID,
		Name:     "Test Room",
		Config:   []byte(`{"maxParticipants": 10}`),
	}

	if input.TenantID != tenantID {
		t.Error("expected tenant ID to match")
	}
	if input.Name != "Test Room" {
		t.Error("expected name to match")
	}
}

func TestCreateRoomOutput(t *testing.T) {
	roomID := uuid.New()
	output := CreateRoomOutput{
		RoomID:              roomID,
		CloudflareMeetingID: "cf-123",
		Room: &db.Room{
			ID:     roomID,
			Status: "active",
		},
	}

	if output.RoomID != roomID {
		t.Error("expected room ID to match")
	}
	if output.CloudflareMeetingID != "cf-123" {
		t.Error("expected cloudflare meeting ID to match")
	}
	if output.Room.Status != "active" {
		t.Error("expected room status to be active")
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

func TestGetActiveParticipants_FromHub(t *testing.T) {
	participantID := uuid.New()
	hub := &mockHub{
		getParticipantsInRoom: func(roomID uuid.UUID) []uuid.UUID {
			return []uuid.UUID{participantID}
		},
	}

	svc := NewService(nil, &mockCloudflareClient{}, &mockRoomState{}, hub)
	participants, err := svc.GetActiveParticipants(context.Background(), uuid.New())

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(participants) != 1 {
		t.Fatalf("expected 1 participant, got %d", len(participants))
	}
	if participants[0] != participantID {
		t.Error("expected participant ID to match")
	}
}

func TestGetActiveParticipants_FromRoomState(t *testing.T) {
	participantID := uuid.New()
	roomState := &mockRoomState{
		getParticipantsFn: func(ctx context.Context, roomID uuid.UUID) (map[uuid.UUID]domain.ParticipantMetadata, error) {
			return map[uuid.UUID]domain.ParticipantMetadata{
				participantID: {DisplayName: "Test"},
			}, nil
		},
	}

	svc := NewService(nil, &mockCloudflareClient{}, roomState, nil)
	participants, err := svc.GetActiveParticipants(context.Background(), uuid.New())

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(participants) != 1 {
		t.Fatalf("expected 1 participant, got %d", len(participants))
	}
}

func TestGetActiveParticipants_NilDependencies(t *testing.T) {
	svc := NewService(nil, &mockCloudflareClient{}, nil, nil)
	participants, err := svc.GetActiveParticipants(context.Background(), uuid.New())

	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if participants != nil {
		t.Error("expected nil participants when no dependencies")
	}
}
