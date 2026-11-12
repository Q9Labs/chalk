package httpapi

import (
	"context"
	"net/http"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingpipeline"
	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type RecordingCapturePoolService interface {
	GetCapturePool(ctx context.Context, tenantID utilities.ID) (recordingpipeline.CapturePool, error)
}

type recordingCapturePoolResponse struct {
	SlotsTotal         int                            `json:"slots_total"`
	SlotsUsed          int                            `json:"slots_used"`
	ObservedAt         *string                        `json:"observed_at,omitempty"`
	Held               []recordingCaptureSlotResponse `json:"held"`
	HeldByOtherTenants int                            `json:"held_by_other_tenants"`
}

type recordingCaptureSlotResponse struct {
	JobID          string `json:"job_id"`
	RecordingID    string `json:"recording_id"`
	EpisodeID      string `json:"episode_id"`
	ClaimedAt      string `json:"claimed_at"`
	LeaseExpiresAt string `json:"lease_expires_at"`
}

// getRecordingCapturePoolEndpoint answers why a Recording has not started: the
// Capture pool is shared, so a slot held by a stuck job blocks every Tenant.
// Slots held for other Tenants are counted without identifiers.
func getRecordingCapturePoolEndpoint(service RecordingCapturePoolService, authorizer TenantAuthorizer) Endpoint[getTenantRequest, recordingCapturePoolResponse] {
	return Get("/v1/tenants/{tenant_id}/recording-capture-pool", "getRecordingCapturePool", decodeGetTenantRequest, func(ctx context.Context, request getTenantRequest) (recordingCapturePoolResponse, error) {
		pool, err := service.GetCapturePool(ctx, request.TenantID)
		if err != nil {
			return recordingCapturePoolResponse{}, err
		}
		return newRecordingCapturePoolResponse(pool), nil
	}).Needs(service).Permission(authorizer, readRecordingsPermission).
		Auth(APIAuthSessionOrBearer).
		Parameters(tenantIDParameter()).
		Responds(http.StatusOK, "RecordingCapturePool", recordingCapturePoolResponse{}).
		Errors(recordingReadErrors()...)
}

func newRecordingCapturePoolResponse(pool recordingpipeline.CapturePool) recordingCapturePoolResponse {
	response := recordingCapturePoolResponse{
		SlotsTotal:         pool.SlotsTotal,
		SlotsUsed:          pool.SlotsUsed,
		Held:               make([]recordingCaptureSlotResponse, 0, len(pool.Held)),
		HeldByOtherTenants: pool.HeldByOtherTenants,
	}
	if pool.ObservedAt != nil {
		observedAt := pool.ObservedAt.UTC().Format(time.RFC3339Nano)
		response.ObservedAt = &observedAt
	}
	for _, slot := range pool.Held {
		response.Held = append(response.Held, recordingCaptureSlotResponse{
			JobID:          slot.JobID.String(),
			RecordingID:    slot.RecordingID.String(),
			EpisodeID:      slot.EpisodeID.String(),
			ClaimedAt:      slot.ClaimedAt.UTC().Format(time.RFC3339Nano),
			LeaseExpiresAt: slot.LeaseExpiresAt.UTC().Format(time.RFC3339Nano),
		})
	}
	return response
}
