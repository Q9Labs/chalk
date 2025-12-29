package recording

import (
	"context"
	"testing"
	"time"

	"github.com/Q9Labs/chalk/internal/infrastructure/cloudflare"
	"github.com/google/uuid"
)

type mockCloudflareClient struct {
	startRecordingFn func(ctx context.Context, meetingID string, req cloudflare.StartRecordingRequest) (*cloudflare.Recording, error)
	stopRecordingFn  func(ctx context.Context, recordingID string) (*cloudflare.Recording, error)
	getRecordingFn   func(ctx context.Context, recordingID string) (*cloudflare.Recording, error)
}

func (m *mockCloudflareClient) StartRecording(ctx context.Context, meetingID string, req cloudflare.StartRecordingRequest) (*cloudflare.Recording, error) {
	if m.startRecordingFn != nil {
		return m.startRecordingFn(ctx, meetingID, req)
	}
	return &cloudflare.Recording{
		ID:        "cf-recording-123",
		MeetingID: meetingID,
		Status:    "RECORDING",
	}, nil
}

func (m *mockCloudflareClient) StopRecording(ctx context.Context, recordingID string) (*cloudflare.Recording, error) {
	if m.stopRecordingFn != nil {
		return m.stopRecordingFn(ctx, recordingID)
	}
	return &cloudflare.Recording{
		ID:     recordingID,
		Status: "STOPPED",
	}, nil
}

func (m *mockCloudflareClient) GetRecording(ctx context.Context, recordingID string) (*cloudflare.Recording, error) {
	if m.getRecordingFn != nil {
		return m.getRecordingFn(ctx, recordingID)
	}
	return &cloudflare.Recording{
		ID:     recordingID,
		Status: "COMPLETED",
	}, nil
}

type mockStorageClient struct {
	getPresignedURLFn func(ctx context.Context, key string, expiry time.Duration) (string, error)
}

func (m *mockStorageClient) GetPresignedURL(ctx context.Context, key string, expiry time.Duration) (string, error) {
	if m.getPresignedURLFn != nil {
		return m.getPresignedURLFn(ctx, key, expiry)
	}
	return "https://storage.example.com/presigned/" + key, nil
}

type mockRoomState struct {
	setRecordingStateFn func(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error
}

func (m *mockRoomState) SetRecordingState(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error {
	if m.setRecordingStateFn != nil {
		return m.setRecordingStateFn(ctx, roomID, isRecording, recordingID)
	}
	return nil
}

type mockHub struct {
	setRoomRecordingStateFn func(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID)
	broadcastToRoomFn       func(roomID uuid.UUID, message []byte, excludeParticipantID string)
}

func (m *mockHub) SetRoomRecordingState(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) {
	if m.setRoomRecordingStateFn != nil {
		m.setRoomRecordingStateFn(roomID, isRecording, recordingID)
	}
}

func (m *mockHub) BroadcastToRoom(roomID uuid.UUID, message []byte, excludeParticipantID string) {
	if m.broadcastToRoomFn != nil {
		m.broadcastToRoomFn(roomID, message, excludeParticipantID)
	}
}

func TestNewService(t *testing.T) {
	cf := &mockCloudflareClient{}
	r2 := &mockStorageClient{}
	s3 := &mockStorageClient{}
	roomState := &mockRoomState{}
	hub := &mockHub{}

	svc := NewService(nil, cf, r2, s3, roomState, hub)

	if svc == nil {
		t.Fatal("expected service to be non-nil")
	}
	if svc.cfClient != cf {
		t.Error("expected cloudflare client to be set")
	}
	if svc.r2Client != r2 {
		t.Error("expected r2 client to be set")
	}
	if svc.s3Client != s3 {
		t.Error("expected s3 client to be set")
	}
	if svc.roomState != roomState {
		t.Error("expected room state to be set")
	}
	if svc.hub != hub {
		t.Error("expected hub to be set")
	}
}

func TestErrors(t *testing.T) {
	if ErrRecordingNotFound.Error() != "recording not found" {
		t.Error("unexpected error message for ErrRecordingNotFound")
	}
	if ErrRecordingNotReady.Error() != "recording not ready" {
		t.Error("unexpected error message for ErrRecordingNotReady")
	}
	if ErrNoActiveRecording.Error() != "no active recording found" {
		t.Error("unexpected error message for ErrNoActiveRecording")
	}
	if ErrRoomNotFound.Error() != "room not found" {
		t.Error("unexpected error message for ErrRoomNotFound")
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

func TestServiceNilStorageClients(t *testing.T) {
	svc := NewService(nil, &mockCloudflareClient{}, nil, nil, nil, nil)

	if svc.r2Client != nil {
		t.Error("expected r2Client to be nil")
	}
	if svc.s3Client != nil {
		t.Error("expected s3Client to be nil")
	}
}

func TestMockCloudflareClient(t *testing.T) {
	cf := &mockCloudflareClient{}

	recording, err := cf.StartRecording(context.Background(), "meeting-123", cloudflare.StartRecordingRequest{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if recording.ID != "cf-recording-123" {
		t.Error("expected recording ID to match")
	}
	if recording.MeetingID != "meeting-123" {
		t.Error("expected meeting ID to match")
	}

	stopped, err := cf.StopRecording(context.Background(), "cf-recording-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if stopped.Status != "STOPPED" {
		t.Error("expected status to be STOPPED")
	}

	got, err := cf.GetRecording(context.Background(), "cf-recording-123")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Status != "COMPLETED" {
		t.Error("expected status to be COMPLETED")
	}
}

func TestMockStorageClient(t *testing.T) {
	storage := &mockStorageClient{}

	url, err := storage.GetPresignedURL(context.Background(), "recordings/test.mp4", time.Hour)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if url != "https://storage.example.com/presigned/recordings/test.mp4" {
		t.Errorf("unexpected URL: %s", url)
	}
}

func TestMockRoomState(t *testing.T) {
	called := false
	roomState := &mockRoomState{
		setRecordingStateFn: func(ctx context.Context, roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) error {
			called = true
			if !isRecording {
				t.Error("expected isRecording to be true")
			}
			return nil
		},
	}

	recordingID := uuid.New()
	err := roomState.SetRecordingState(context.Background(), uuid.New(), true, &recordingID)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !called {
		t.Error("expected SetRecordingState to be called")
	}
}

func TestMockHub(t *testing.T) {
	hubCalled := false
	hub := &mockHub{
		setRoomRecordingStateFn: func(roomID uuid.UUID, isRecording bool, recordingID *uuid.UUID) {
			hubCalled = true
		},
	}

	recordingID := uuid.New()
	hub.SetRoomRecordingState(uuid.New(), true, &recordingID)

	if !hubCalled {
		t.Error("expected SetRoomRecordingState to be called on hub")
	}
}
