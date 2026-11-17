package httpapi

import (
	"net/http"

	"github.com/q9labs/chalk/apps/api/internal/recorderprotocol"
	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func recorderWorkerJobResponseValue(job recordingpipeline.Job) recorderprotocol.JobResponse {
	response := recorderprotocol.JobResponse{JobID: job.ID.String(), TenantID: job.TenantID.String(), EpisodeID: job.EpisodeID.String(), RecordingID: job.RecordingID.String(), Kind: string(job.Kind), State: string(job.State), AttemptCount: job.AttemptCount, AttemptLimit: job.AttemptLimit, FencingGeneration: job.FencingGeneration, CaptureEpoch: job.CaptureEpoch, AvailableAt: utilities.FormatTimestamp(job.AvailableAt), UpdatedAt: utilities.FormatTimestamp(job.UpdatedAt), CreatedAt: utilities.FormatTimestamp(job.CreatedAt)}
	if job.Authority != nil {
		response.EnvelopeDigest = recordingpipeline.EnvelopeDigestHex(job.Authority.EnvelopeDigest)
	}
	if job.LeaseToken != nil {
		response.LeaseToken = *job.LeaseToken
	}
	if job.LeaseOwner != nil {
		response.LeaseOwner = *job.LeaseOwner
	}
	if job.LeaseExpiresAt != nil {
		value := utilities.FormatTimestamp(*job.LeaseExpiresAt)
		response.LeaseExpiresAt = &value
	}
	if job.ErrorCode != nil {
		response.ErrorCode = *job.ErrorCode
	}
	if job.ErrorDetail != nil {
		response.ErrorDetail = *job.ErrorDetail
	}
	if job.TerminalAt != nil {
		value := utilities.FormatTimestamp(*job.TerminalAt)
		response.TerminalAt = &value
	}
	return response
}

func recorderWorkerArtifactResponseValue(artifact recordingpipeline.Artifact) recorderprotocol.ArtifactResponse {
	return recorderprotocol.ArtifactResponse{RecordingID: artifact.RecordingID.String(), TenantID: artifact.TenantID.String(), RenderJobID: artifact.RenderJobID.String(), ObjectKey: artifact.ObjectKey, ContentType: artifact.ContentType, ByteSize: artifact.ByteSize, Checksum: checksumString(artifact.Checksum), DurationMillis: artifact.Duration.Milliseconds(), CommittedAt: utilities.FormatTimestamp(artifact.CommittedAt), CreatedAt: utilities.FormatTimestamp(artifact.CreatedAt)}
}

func recorderWorkerPoolHealthResponseValue(health recordingpipeline.PoolHealth) recorderprotocol.PoolHealthResponse {
	return recorderprotocol.PoolHealthResponse{Role: string(health.Role), AdmissionOpen: health.AdmissionOpen, ReadyCapacity: health.ReadyCapacity, Reason: health.Reason, ObservedAt: utilities.FormatTimestamp(health.ObservedAt), UpdatedAt: utilities.FormatTimestamp(health.UpdatedAt)}
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

// recorderWorkerObservations turns what the recorder reported into the stored facts. A negative
// count cannot come from a capture, so it is a bad request, not a value to clamp.
func recorderWorkerObservations(w http.ResponseWriter, observed *recorderprotocol.CaptureObserved) (*recordingpipeline.CaptureObservations, bool) {
	if observed != nil {
		if observed.Tracks < 0 || observed.Packets < 0 {
			writeError(w, http.StatusBadRequest, "request.invalid", "Invalid capture observations")
			return nil, false
		}
		return &recordingpipeline.CaptureObservations{Tracks: observed.Tracks, Packets: observed.Packets}, true
	}
	return nil, true
}
