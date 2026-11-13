package recorderworker

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func (attempt *ProductionRenderAttempt) currentAuthority() recordingrender.Authority {
	attempt.mu.Lock()
	defer attempt.mu.Unlock()
	authority := attempt.authority
	authority.EnvelopeDigest = append([]byte(nil), authority.EnvelopeDigest...)
	return authority
}

func renderAuthorityFromClaim(claim ClaimResult, now time.Time) (recordingrender.Authority, error) {
	envelope := claim.Envelope
	tenantID, e1 := utilities.ParseID(envelope.TenantID)
	spaceID, e2 := utilities.ParseID(envelope.SpaceID)
	episodeID, e3 := utilities.ParseID(envelope.EpisodeID)
	recordingID, e4 := utilities.ParseID(envelope.RecordingID)
	jobID, e5 := utilities.ParseID(envelope.JobID)
	renderInputHandle, e6 := utilities.ParseID(envelope.RenderInputHandle)
	keyHandle, e7 := utilities.ParseID(envelope.KeyHandle)
	objectHandle, e8 := utilities.ParseID(envelope.ObjectHandle)
	_, e9 := utilities.ParseID(envelope.PresentationHandle)
	presentationSHA, e10 := hex.DecodeString(envelope.PresentationSHA256)
	var e11 error
	if envelope.CaptureReadyAt == nil {
		e11 = errors.New("capture ready time is absent")
	} else {
		_, e11 = time.Parse(time.RFC3339Nano, *envelope.CaptureReadyAt)
	}
	deadline, e12 := time.Parse(time.RFC3339Nano, envelope.HardDeadline)
	if !deadline.After(now.UTC()) || errors.Join(e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12) != nil || len(presentationSHA) != sha256.Size || envelope.PresentationSHA256 != strings.ToLower(envelope.PresentationSHA256) || !isRenderWorkerJobKind(envelope.Kind) || claim.ClaimRequestID.IsZero() || len(claim.EnvelopeDigest) != sha256.Size || strings.TrimSpace(claim.LeaseToken) == "" || strings.TrimSpace(claim.LeaseOwner) == "" || !claim.LeaseExpiresAt.After(now.UTC()) {
		return recordingrender.Authority{}, ErrInvalidProductionRenderAttempt
	}
	authority := recordingrender.Authority{
		TenantID: tenantID, SpaceID: spaceID, EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		RenderInputHandle: renderInputHandle, KeyHandle: keyHandle, ObjectHandle: objectHandle,
		AttemptCount: envelope.AttemptCount, FencingGeneration: envelope.FencingGeneration, CaptureEpoch: envelope.CaptureEpoch,
		EnvelopeDigest: append([]byte(nil), claim.EnvelopeDigest...), LeaseToken: claim.LeaseToken, LeaseOwner: claim.LeaseOwner, LeaseExpiresAt: claim.LeaseExpiresAt,
	}
	if err := authority.Validate(); err != nil || envelope.PresentationHandle == "" || envelope.PresentationSHA256 == "" || envelope.CaptureReadyAt == nil {
		return recordingrender.Authority{}, ErrInvalidProductionRenderAttempt
	}
	return authority, nil
}

func isRenderWorkerJobKind(kind recordingpipeline.JobKind) bool {
	return kind == recordingpipeline.JobKindRender || kind == recordingpipeline.JobKindTranscription
}

func equalRenderDuration(left, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func deterministicRenderID(authority recordingrender.Authority, name string) utilities.ID {
	hash := sha256.New()
	_, _ = hash.Write([]byte("chalk.recording.render.id.v1\x00"))
	_, _ = hash.Write([]byte(authority.RecordingID.String()))
	_, _ = hash.Write([]byte{'\x00'})
	_, _ = hash.Write([]byte(authority.JobID.String()))
	_, _ = hash.Write([]byte{'\x00'})
	_, _ = hash.Write([]byte(strconv.FormatInt(authority.FencingGeneration, 10)))
	_, _ = hash.Write([]byte{'\x00'})
	_, _ = hash.Write([]byte(name))
	sum := hash.Sum(nil)
	var value [16]byte
	copy(value[:], sum)
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	clear(sum)
	return utilities.IDFromBytes(value)
}
