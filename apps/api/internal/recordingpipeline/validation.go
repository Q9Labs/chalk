package recordingpipeline

import (
	"crypto/sha256"
	"encoding/binary"
	"strings"
	"time"
)

// ReservationFingerprint is the stable request identity used to make retries
// safe even when the caller generates a fresh recording ID for each attempt.
func ReservationFingerprint(input ReservationInput) [32]byte {
	h := sha256.New()
	tenantID := input.TenantID.Bytes()
	roomID := input.RoomID.Bytes()
	sessionID := input.SessionID.Bytes()
	h.Write(tenantID[:])
	h.Write(roomID[:])
	h.Write(sessionID[:])
	var number [8]byte
	binary.BigEndian.PutUint64(number[:], uint64(input.ParticipantCount))
	h.Write(number[:])
	binary.BigEndian.PutUint64(number[:], uint64(input.MaxDuration/time.Second))
	h.Write(number[:])
	binary.BigEndian.PutUint64(number[:], uint64(input.InputBitrateBPS))
	h.Write(number[:])
	if input.StartsAt != nil {
		h.Write([]byte(input.StartsAt.UTC().Format(time.RFC3339Nano)))
	}
	var fingerprint [32]byte
	copy(fingerprint[:], h.Sum(nil))
	return fingerprint
}

func ValidateReservationInput(input ReservationInput) error {
	if input.TenantID.IsZero() {
		return ErrInvalidTenantID
	}
	if input.RoomID.IsZero() {
		return ErrInvalidRoomID
	}
	if input.SessionID.IsZero() {
		return ErrInvalidSessionID
	}
	if strings.TrimSpace(input.IdempotencyKey) == "" || len(input.IdempotencyKey) > 128 {
		return ErrInvalidIdempotencyKey
	}
	if input.ParticipantCount < MinimumMeetingParticipants || input.ParticipantCount > MaximumMeetingParticipants {
		return ErrInvalidParticipantCount
	}
	if input.MaxDuration <= 0 || input.MaxDuration > MaximumRecordingDuration {
		return ErrInvalidDuration
	}
	if input.InputBitrateBPS <= 0 || input.InputBitrateBPS > MaximumInputBitrateBPS {
		return ErrInvalidInputBitrate
	}
	return nil
}

func ValidateLeaseInput(input LeaseInput) error {
	if input.JobID.IsZero() {
		return ErrInvalidJobID
	}
	if input.AttemptCount <= 0 || input.FencingGeneration <= 0 {
		return ErrInvalidAttempt
	}
	if strings.TrimSpace(input.LeaseToken) == "" {
		return ErrInvalidLease
	}
	if strings.TrimSpace(input.LeaseOwner) == "" {
		return ErrInvalidOwner
	}
	if input.LeaseFor <= 0 {
		return ErrInvalidLease
	}
	return nil
}

func BuildReservation(input ReservationInput, now time.Time) (ReservationInput, time.Time, error) {
	if err := ValidateReservationInput(input); err != nil {
		return ReservationInput{}, time.Time{}, err
	}
	start := now
	if input.StartsAt != nil {
		start = input.StartsAt.UTC()
		input.StartsAt = &start
	}
	return input, start.Add(input.MaxDuration), nil
}

func ValidateBundleInput(input BundleInput) error {
	if input.TenantID.IsZero() || input.RecordingID.IsZero() || input.CaptureJobID.IsZero() {
		return ErrInvalidRecordingID
	}
	if input.ID.IsZero() || input.SequenceNumber < 0 || input.FencingGeneration <= 0 {
		return ErrInvalidAttempt
	}
	if input.AttemptCount <= 0 || input.LeaseToken == "" || input.LeaseOwner == "" {
		return ErrInvalidLease
	}
	if strings.TrimSpace(input.ObjectKey) == "" || strings.TrimSpace(input.ContentType) == "" || strings.TrimSpace(input.Codec) == "" {
		return ErrInvalidLease
	}
	if input.ByteSize < 0 || len(input.Checksum) < 16 {
		return ErrInvalidLease
	}
	if input.MonotonicStartMillis < 0 || input.MonotonicEndMillis < input.MonotonicStartMillis || input.MediaStartMillis < 0 || input.MediaEndMillis < input.MediaStartMillis {
		return ErrInvalidLease
	}
	return nil
}

func ValidateArtifactInput(input ArtifactInput) error {
	if input.TenantID.IsZero() || input.RecordingID.IsZero() || input.RenderJobID.IsZero() {
		return ErrInvalidRecordingID
	}
	if strings.TrimSpace(input.ObjectKey) == "" || strings.TrimSpace(input.ContentType) == "" {
		return ErrInvalidLease
	}
	if input.ByteSize < 0 || input.Duration < 0 || len(input.Checksum) < 16 {
		return ErrInvalidLease
	}
	if input.AttemptCount <= 0 || input.FencingGeneration <= 0 || input.LeaseToken == "" || input.LeaseOwner == "" {
		return ErrInvalidLease
	}
	return nil
}
