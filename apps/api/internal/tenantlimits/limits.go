package tenantlimits

import "errors"

var (
	ErrRecordingLimitReached   = errors.New("tenant recording limit reached")
	ErrLiveEpisodeLimitReached = errors.New("tenant live episode limit reached")
)

type Config struct {
	MaxConcurrentRecordings int32
	DailyRecordingMinutes   int32
	MaxLiveEpisodes         int32
}

const (
	RecordingLimitReason = "tenant_recording_limit_reached"
	RecordingLimitCode   = "tenant.recording_limit_reached"
	LiveEpisodeLimitCode = "tenant.live_episode_limit_reached"
)
