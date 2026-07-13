package httpapi_test

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/httpapi"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingPipelineService struct {
	reserve func(context.Context, recordingpipeline.ReservationInput) (recordingpipeline.Reservation, error)
}

func mustRecordingPipelineID(t *testing.T, value string) utilities.ID {
	t.Helper()

	id, err := utilities.ParseID(value)
	if err != nil {
		t.Fatalf("parse recording pipeline id: %v", err)
	}

	return id
}

func (s recordingPipelineService) Reserve(ctx context.Context, input recordingpipeline.ReservationInput) (recordingpipeline.Reservation, error) {
	return s.reserve(ctx, input)
}
func (recordingPipelineService) GetReservation(context.Context, utilities.ID, utilities.ID) (recordingpipeline.Reservation, error) {
	return recordingpipeline.Reservation{}, recordingpipeline.ErrReservationNotFound
}
func (recordingPipelineService) ReleaseReservation(context.Context, utilities.ID, utilities.ID, recordingpipeline.ReservationState) (recordingpipeline.Reservation, error) {
	return recordingpipeline.Reservation{}, recordingpipeline.ErrReservationNotFound
}
func (recordingPipelineService) ExtendReservation(context.Context, utilities.ID, utilities.ID, time.Duration, time.Time) (recordingpipeline.Reservation, error) {
	return recordingpipeline.Reservation{}, recordingpipeline.ErrReservationNotFound
}
func (recordingPipelineService) GetPipeline(context.Context, utilities.ID, utilities.ID) (recordingpipeline.Pipeline, error) {
	return recordingpipeline.Pipeline{}, recordingpipeline.ErrPipelineNotFound
}

func TestCreateRecordingReservationUsesBoundedTenantAuthorizedContract(t *testing.T) {
	tenantID := mustRecordingPipelineID(t, "11111111-1111-4111-8111-111111111111")
	roomID := mustRecordingPipelineID(t, "22222222-2222-4222-8222-222222222222")
	sessionID := mustRecordingPipelineID(t, "33333333-3333-4333-8333-333333333333")
	now := time.Date(2026, 7, 13, 2, 0, 0, 0, time.UTC)
	service := recordingPipelineService{reserve: func(_ context.Context, input recordingpipeline.ReservationInput) (recordingpipeline.Reservation, error) {
		if input.TenantID != tenantID || input.RoomID != roomID || input.SessionID != sessionID || input.IdempotencyKey != "recording-request-0001" || input.MaxDuration != 45*time.Minute {
			t.Fatalf("reserve input = %#v", input)
		}
		return recordingpipeline.Reservation{ID: mustRecordingPipelineID(t, "44444444-4444-4444-8444-444444444444"), TenantID: tenantID, RoomID: roomID, SessionID: sessionID, RecordingID: input.RecordingID, ParticipantCount: input.ParticipantCount, MaxDuration: input.MaxDuration, InputBitrateBPS: input.InputBitrateBPS, State: recordingpipeline.ReservationStateReserved, EndsAt: now.Add(45 * time.Minute), UpdatedAt: now, CreatedAt: now}, nil
	}}
	request := bearerRequestWithBody(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/recording-reservations", "raw-session-token", `{"participant_count":3,"max_duration_minutes":45,"input_bitrate_bps":4000000}`)
	request.Header.Set("Idempotency-Key", "recording-request-0001")
	response := requestWithOptionsAndRequest(t, request, authenticatedOptions(t, httpapi.Options{RecordingPipeline: service}))
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if body["state"] != "reserved" || body["recording_id"] == "" {
		t.Fatalf("body = %#v", body)
	}
}

func TestCreateRecordingReservationRequiresAuthentication(t *testing.T) {
	service := recordingPipelineService{reserve: func(context.Context, recordingpipeline.ReservationInput) (recordingpipeline.Reservation, error) {
		t.Fatal("unauthenticated request reached the recording pipeline service")
		return recordingpipeline.Reservation{}, nil
	}}
	response := requestWithOptionsAndRequest(t, bearerRequestWithBody(http.MethodPost, "/v1/tenants/11111111-1111-4111-8111-111111111111/rooms/22222222-2222-4222-8222-222222222222/sessions/33333333-3333-4333-8333-333333333333/recording-reservations", "", `{}`), httpapi.Options{Authentication: authenticationService{}, RecordingPipeline: service})
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
}
