package recorderworker

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func leaseRequest(input recordingpipeline.LeaseInput) (recorderprotocol.LeaseRequest, error) {
	seconds, err := durationSeconds(input.LeaseFor)
	if err != nil || input.JobID.IsZero() || input.AttemptCount < 1 || input.FencingGeneration < 1 || input.CaptureEpoch < 1 || strings.TrimSpace(input.LeaseToken) == "" || len(input.EnvelopeDigest) != 32 {
		return recorderprotocol.LeaseRequest{}, fmt.Errorf("%w: lease input", ErrInvalidControlPlaneRequest)
	}
	return recorderprotocol.LeaseRequest{JobID: input.JobID.String(), AttemptCount: input.AttemptCount, FencingGeneration: input.FencingGeneration, LeaseToken: input.LeaseToken, LeaseForSeconds: seconds, CaptureEpoch: input.CaptureEpoch, EnvelopeDigest: hex.EncodeToString(input.EnvelopeDigest)}, nil
}

func decodeClaimResult(requestID utilities.ID, response recorderprotocol.ClaimResponse) (ClaimResult, error) {
	claimID, err := utilities.ParseID(response.ClaimRequestID)
	if err != nil || claimID != requestID || strings.TrimSpace(response.LeaseToken) == "" || strings.TrimSpace(response.LeaseOwner) == "" {
		return ClaimResult{}, ProtocolError{Err: errors.New("claim response identity")}
	}
	digest, err := decodeHex(response.EnvelopeDigest, 32)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: errors.New("claim response digest")}
	}
	envelopeBytes, err := json.Marshal(response.Envelope)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: err}
	}
	envelope, err := recordingpipeline.DecodeRecorderJobEnvelope(envelopeBytes, digest)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: err}
	}
	leaseExpiresAt, err := parseRequiredTime(response.LeaseExpiresAt)
	if err != nil {
		return ClaimResult{}, ProtocolError{Err: err}
	}
	return ClaimResult{ClaimRequestID: claimID, Envelope: envelope, EnvelopeDigest: digest, LeaseToken: response.LeaseToken, LeaseOwner: response.LeaseOwner, LeaseExpiresAt: leaseExpiresAt}, nil
}

func decodeJob(response recorderprotocol.JobResponse) (recordingpipeline.Job, error) {
	jobID, err := utilities.ParseID(response.JobID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response identity")}
	}
	tenantID, err := utilities.ParseID(response.TenantID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response tenant")}
	}
	episodeID, err := utilities.ParseID(response.EpisodeID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response episode")}
	}
	recordingID, err := utilities.ParseID(response.RecordingID)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response recording")}
	}
	if response.Kind != string(recordingpipeline.JobKindCapture) && !isRenderWorkerJobKind(recordingpipeline.JobKind(response.Kind)) {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response kind")}
	}
	switch recordingpipeline.JobState(response.State) {
	case recordingpipeline.JobStatePending, recordingpipeline.JobStateLeased, recordingpipeline.JobStateSucceeded,
		recordingpipeline.JobStateRetryableFailure, recordingpipeline.JobStateTerminalFailure, recordingpipeline.JobStateCancelled:
	default:
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response state")}
	}
	if response.EnvelopeDigest != "" {
		if _, err := decodeHex(response.EnvelopeDigest, 32); err != nil {
			return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response digest")}
		}
	}
	availableAt, err := parseRequiredTime(response.AvailableAt)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response available time")}
	}
	updatedAt, err := parseRequiredTime(response.UpdatedAt)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response update time")}
	}
	createdAt, err := parseRequiredTime(response.CreatedAt)
	if err != nil {
		return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response create time")}
	}
	job := recordingpipeline.Job{ID: jobID, TenantID: tenantID, EpisodeID: episodeID, RecordingID: recordingID, Kind: recordingpipeline.JobKind(response.Kind), State: recordingpipeline.JobState(response.State), AttemptCount: response.AttemptCount, AttemptLimit: response.AttemptLimit, FencingGeneration: response.FencingGeneration, CaptureEpoch: response.CaptureEpoch, AvailableAt: availableAt, UpdatedAt: updatedAt, CreatedAt: createdAt}
	if response.LeaseToken != "" {
		job.LeaseToken = stringPointer(response.LeaseToken)
	}
	if response.LeaseOwner != "" {
		job.LeaseOwner = stringPointer(response.LeaseOwner)
	}
	if response.LeaseExpiresAt != nil {
		value, err := parseRequiredTime(*response.LeaseExpiresAt)
		if err != nil {
			return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response lease expiry")}
		}
		job.LeaseExpiresAt = &value
	}
	if response.ErrorCode != "" {
		job.ErrorCode = stringPointer(response.ErrorCode)
	}
	if response.ErrorDetail != "" {
		job.ErrorDetail = stringPointer(response.ErrorDetail)
	}
	if response.TerminalAt != nil {
		value, err := parseRequiredTime(*response.TerminalAt)
		if err != nil {
			return recordingpipeline.Job{}, ProtocolError{Err: errors.New("job response terminal time")}
		}
		job.TerminalAt = &value
	}
	return job, nil
}

func verifyJobAuthority(job recordingpipeline.Job, input recordingpipeline.LeaseInput) error {
	if job.ID != input.JobID || job.AttemptCount != input.AttemptCount || job.FencingGeneration != input.FencingGeneration || job.CaptureEpoch != input.CaptureEpoch {
		return ProtocolError{Err: errors.New("job response authority mismatch")}
	}
	return nil
}

func verifyPlanAuthority(plan captureplan.Plan, input captureplan.WaitInput) error {
	actual := plan.Authority()
	expected := input.Authority()
	if actual.PlanHandle != expected.PlanHandle || actual.TenantID != expected.TenantID || actual.SpaceID != expected.SpaceID || actual.EpisodeID != expected.EpisodeID || actual.RecordingID != expected.RecordingID || actual.JobID != expected.JobID || actual.AttemptCount != expected.AttemptCount || actual.FencingGeneration != expected.FencingGeneration || actual.CaptureEpoch != expected.CaptureEpoch || !bytes.Equal(actual.EnvelopeDigest, expected.EnvelopeDigest) {
		return ProtocolError{Err: errors.New("plan response authority mismatch")}
	}
	return nil
}
