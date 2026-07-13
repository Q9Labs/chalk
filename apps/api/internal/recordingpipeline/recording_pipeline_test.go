package recordingpipeline

import (
	"errors"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestValidateReservationLimits(t *testing.T) {
	tenant := utilities.IDFromBytes([16]byte{1})
	room := utilities.IDFromBytes([16]byte{2})
	session := utilities.IDFromBytes([16]byte{3})
	base := ReservationInput{
		TenantID: tenant, RoomID: room, SessionID: session,
		IdempotencyKey: "recording-test-key", ParticipantCount: 3,
		MaxDuration: time.Hour, InputBitrateBPS: 3_000_000,
	}
	if err := ValidateReservationInput(base); err != nil {
		t.Fatalf("valid reservation: %v", err)
	}
	base.ParticipantCount = MaximumMeetingParticipants + 1
	if !errors.Is(ValidateReservationInput(base), ErrInvalidParticipantCount) {
		t.Fatal("expected participant limit error")
	}
	base = ReservationInput{TenantID: tenant, RoomID: room, SessionID: session, IdempotencyKey: "recording-test-key", ParticipantCount: 1, MaxDuration: MaximumRecordingDuration + time.Second, InputBitrateBPS: 1}
	if !errors.Is(ValidateReservationInput(base), ErrInvalidDuration) {
		t.Fatal("expected duration limit error")
	}
	base.MaxDuration = time.Second
	base.InputBitrateBPS = MaximumInputBitrateBPS + 1
	if !errors.Is(ValidateReservationInput(base), ErrInvalidInputBitrate) {
		t.Fatal("expected bitrate limit error")
	}
}

func TestCapturePlacementUsesMaximumDimension(t *testing.T) {
	placement := CapturePlacement{MeetingsPerNode: 4, ParticipantsPerNode: 40, InputMbpsPerNode: 16, ReadySpare: 1}
	if got := DesiredCaptureNodes(20, 100, 80_000_000, placement); got != 6 {
		t.Fatalf("desired nodes = %d, want 6", got)
	}
	if got := DesiredCaptureNodes(0, 0, 0, placement); got != 0 {
		t.Fatalf("empty desired nodes = %d, want 0", got)
	}
}

func TestRecordingStateTransitionsAreExact(t *testing.T) {
	if err := ValidateTransition(StateReserved, StateCaptureLeased); err != nil {
		t.Fatalf("capture lease transition: %v", err)
	}
	if err := ValidateTransition(StateCommitted, StateRendering); !errors.Is(err, ErrInvalidStateTransition) {
		t.Fatalf("committed to rendering error = %v", err)
	}
	if !CanAdmit(MaximumMeetings, MaximumParticipants, MaximumInputBitrateTotalBPS) {
		t.Fatal("qualified ceiling should be admitted")
	}
	if CanAdmit(MaximumMeetings+1, 0, 0) {
		t.Fatal("meeting ceiling should be closed")
	}
}

func TestRetryAvailableAtIsBoundedAndJitterReady(t *testing.T) {
	now := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	got := RetryAvailableAt(now, 5, time.Second, 10*time.Second, 500*time.Millisecond)
	if !got.Equal(now.Add(10 * time.Second)) {
		t.Fatalf("retry time = %s, want bounded ten seconds", got)
	}
}

func TestPoolHealthFailsClosedWhenStale(t *testing.T) {
	now := time.Date(2026, 7, 13, 0, 0, 0, 0, time.UTC)
	health := PoolHealth{Role: PoolRoleCapture, AdmissionOpen: true, ReadyCapacity: 1, ObservedAt: now.Add(-time.Minute)}
	if !health.AdmissionReady(now, 2*time.Minute) {
		t.Fatal("fresh healthy pool should admit")
	}
	if health.AdmissionReady(now, 30*time.Second) {
		t.Fatal("stale pool should fail closed")
	}
}
