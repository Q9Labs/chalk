package httpapi

import (
	"encoding/hex"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/captureplan"
	"github.com/q9labs/chalk/apps/api/internal/captureplane"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
	"github.com/q9labs/chalk/apps/api/internal/workeridentity"
)

func recorderWorkerRequestIdentity(w http.ResponseWriter, request *http.Request) (workeridentity.Identity, bool) {
	identity, ok := recorderWorkerIdentity(request.Context())
	if !ok || identity.WorkerID.IsZero() || (identity.Role != workeridentity.RoleCapture && identity.Role != workeridentity.RoleRender) {
		writeError(w, http.StatusUnauthorized, "worker.unauthorized", "Worker authentication required")
		return workeridentity.Identity{}, false
	}
	return identity, true
}

func recorderWorkerJobKind(role workeridentity.Role) recordingpipeline.JobKind {
	if role == workeridentity.RoleRender {
		return recordingpipeline.JobKindRender
	}
	return recordingpipeline.JobKindCapture
}

func recorderWorkerPoolRole(role workeridentity.Role) recordingpipeline.PoolRole {
	if role == workeridentity.RoleRender {
		return recordingpipeline.PoolRoleRender
	}
	return recordingpipeline.PoolRoleCapture
}

func recorderWorkerLeaseOwner(identity workeridentity.Identity) string {
	return identity.WorkerID.String()
}

func recorderWorkerLeaseDuration(seconds int) (time.Duration, bool) {
	if seconds == 0 {
		return recorderWorkerDefaultLease, true
	}
	if seconds < 1 {
		return 0, false
	}
	duration := time.Duration(seconds) * time.Second
	return duration, duration <= recorderWorkerMaxLease
}

func recorderWorkerLeaseInput(identity workeridentity.Identity, body recorderWorkerLeaseBody) (recordingpipeline.LeaseInput, bool) {
	jobID, err := utilities.ParseID(body.JobID)
	digest, digestErr := decodeEnvelopeDigest(body.EnvelopeDigest)
	if err != nil || digestErr != nil || body.AttemptCount < 1 || body.FencingGeneration < 1 || body.CaptureEpoch < 1 || strings.TrimSpace(body.LeaseToken) == "" {
		return recordingpipeline.LeaseInput{}, false
	}
	leaseFor, valid := recorderWorkerLeaseDuration(body.LeaseForSeconds)
	if !valid {
		return recordingpipeline.LeaseInput{}, false
	}
	return recordingpipeline.LeaseInput{JobID: jobID, AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration, LeaseToken: body.LeaseToken, LeaseOwner: recorderWorkerLeaseOwner(identity), LeaseFor: leaseFor, CaptureEpoch: body.CaptureEpoch, EnvelopeDigest: digest}, true
}

func recorderWorkerCapturePlanWaitInput(identity workeridentity.Identity, body recorderWorkerCapturePlanWaitBody) (captureplan.WaitInput, bool) {
	planHandle, planErr := utilities.ParseID(body.PlanHandle)
	tenantID, tenantErr := utilities.ParseID(body.TenantID)
	spaceID, spaceErr := utilities.ParseID(body.SpaceID)
	episodeID, episodeErr := utilities.ParseID(body.EpisodeID)
	recordingID, recordingErr := utilities.ParseID(body.RecordingID)
	jobID, jobErr := utilities.ParseID(body.JobID)
	digest, digestErr := decodeEnvelopeDigest(body.EnvelopeDigest)
	leaseExpiresAt, expiryErr := time.Parse(time.RFC3339Nano, body.LeaseExpiresAt)
	if planErr != nil || tenantErr != nil || spaceErr != nil || episodeErr != nil || recordingErr != nil ||
		jobErr != nil || digestErr != nil || expiryErr != nil || body.AttemptCount <= 0 ||
		body.FencingGeneration <= 0 || body.CaptureEpoch <= 0 || body.AfterRevision < 0 ||
		body.WaitMilliseconds < captureplan.MinimumWait.Milliseconds() || body.WaitMilliseconds > captureplan.MaximumWait.Milliseconds() ||
		strings.TrimSpace(body.LeaseToken) == "" {
		return captureplan.WaitInput{}, false
	}
	authority := captureplan.PlanAuthority{
		PlanHandle: captureplan.PlanHandle(planHandle.String()), TenantID: tenantID, SpaceID: spaceID,
		EpisodeID: episodeID, RecordingID: recordingID, JobID: jobID,
		AttemptCount: body.AttemptCount, FencingGeneration: body.FencingGeneration,
		CaptureEpoch: captureplane.CaptureEpoch(body.CaptureEpoch), EnvelopeDigest: digest,
	}
	input := captureplan.NewWaitInput(
		authority,
		captureplan.WorkerLease{Owner: recorderWorkerLeaseOwner(identity), Token: body.LeaseToken, ExpiresAt: leaseExpiresAt.UTC()},
		captureplane.PlanRevision(body.AfterRevision),
		time.Duration(body.WaitMilliseconds)*time.Millisecond,
	)
	return input, input.Validate(time.Now().UTC()) == nil
}

func decodeEnvelopeDigest(value string) ([]byte, error) {
	digest, err := hex.DecodeString(strings.TrimSpace(value))
	if err != nil || len(digest) != 32 {
		return nil, errors.New("invalid envelope digest")
	}
	return digest, nil
}

func decodeRecorderWorkerBody[T any](w http.ResponseWriter, request *http.Request) (T, bool) {
	return decodeRecorderWorkerBodyWithLimit[T](w, request, maxRequestBodyBytes)
}

func decodeRecorderWorkerBodyWithLimit[T any](w http.ResponseWriter, request *http.Request, limit int64) (T, bool) {
	body, err := decodeJSONBodyWithLimit[T](request, limit)
	if err != nil {
		if apiErr, ok := errorAsAPIError(err); ok {
			writeAPIError(w, apiErr)
		} else {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid request body")
		}
		var zero T
		return zero, false
	}
	return body, true
}

func checksumString(value []byte) string {
	const hexChars = "0123456789abcdef"
	result := make([]byte, len(value)*2)
	for index, item := range value {
		result[index*2] = hexChars[item>>4]
		result[index*2+1] = hexChars[item&15]
	}
	return string(result)
}
