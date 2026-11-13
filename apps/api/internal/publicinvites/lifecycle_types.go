package publicinvites

import (
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type AutoLifecycleState string

const (
	AutoLifecycleActive    AutoLifecycleState = "active"
	AutoLifecycleArchiving AutoLifecycleState = "archiving"
	AutoLifecycleArchived  AutoLifecycleState = "archived"
)

type AutoLifecycle struct {
	TenantID             utilities.ID
	SpaceID              utilities.ID
	DeadlineAt           time.Time
	CreatorArrivalHandle utilities.ID
	State                AutoLifecycleState
	NextRetryAt          *time.Time
	RetryCount           int32
	LastErrorFamily      string
	ArchiveCompletedAt   *time.Time
	JourneyID            utilities.ID
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type RetryAutoLifecycleInput struct {
	TenantID    utilities.ID
	SpaceID     utilities.ID
	NextRetryAt time.Time
	ErrorFamily string
}
