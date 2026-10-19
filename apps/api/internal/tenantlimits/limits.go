package tenantlimits

import (
	"errors"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

var (
	ErrRecordingLimitReached   = errors.New("tenant recording limit reached")
	ErrLiveEpisodeLimitReached = errors.New("tenant live episode limit reached")
)

type Config struct {
	ManagedPublicTenantID   utilities.ID
	MaxConcurrentRecordings int32
	DailyRecordingMinutes   int32
	MaxLiveEpisodes         int32
}

func (c Config) AppliesTo(tenantID utilities.ID) bool {
	return c.ManagedPublicTenantID.IsZero() || tenantID != c.ManagedPublicTenantID
}

const (
	RecordingLimitReason = "tenant_recording_limit_reached"
	RecordingLimitCode   = "tenant.recording_limit_reached"
	LiveEpisodeLimitCode = "tenant.live_episode_limit_reached"
)
