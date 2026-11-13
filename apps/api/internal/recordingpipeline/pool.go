package recordingpipeline

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type PoolRole string

const (
	PoolRoleCapture PoolRole = "capture"
	PoolRoleRender  PoolRole = "render"
)

type PoolHealth struct {
	Role          PoolRole
	AdmissionOpen bool
	ReadyCapacity int
	Reason        string
	ObservedAt    time.Time
	UpdatedAt     time.Time
}

// HeldCaptureSlot is a Capture job leased by a worker, which therefore holds
// one slot of the Capture pool until it completes, fails or its lease is recovered.
type HeldCaptureSlot struct {
	JobID          utilities.ID
	TenantID       utilities.ID
	RecordingID    utilities.ID
	EpisodeID      utilities.ID
	ClaimedAt      time.Time
	LeaseExpiresAt time.Time
}

// CapturePool is a Tenant's view of the shared Capture pool. Slots held for
// other Tenants are counted only, so no identifier crosses a Tenant boundary.
type CapturePool struct {
	SlotsTotal         int
	SlotsUsed          int
	ObservedAt         *time.Time
	Held               []HeldCaptureSlot
	HeldByOtherTenants int
}
