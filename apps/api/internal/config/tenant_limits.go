package config

import (
	"fmt"

	"github.com/q9labs/chalk/apps/api/internal/tenantlimits"
)

const (
	TenantMaxConcurrentRecordings = "CHALK_TENANT_MAX_CONCURRENT_RECORDINGS"
	TenantDailyRecordingMinutes   = "CHALK_TENANT_DAILY_RECORDING_MINUTES"
	TenantMaxLiveEpisodes         = "CHALK_TENANT_MAX_LIVE_EPISODES"
)

func loadTenantLimits() (tenantlimits.Config, error) {
	var limits tenantlimits.Config
	for _, setting := range []struct {
		name   string
		target *int32
	}{
		{TenantMaxConcurrentRecordings, &limits.MaxConcurrentRecordings},
		{TenantDailyRecordingMinutes, &limits.DailyRecordingMinutes},
		{TenantMaxLiveEpisodes, &limits.MaxLiveEpisodes},
	} {
		value, err := envInt32(setting.name, 0)
		if err != nil {
			return tenantlimits.Config{}, err
		}
		if value < 0 {
			return tenantlimits.Config{}, fmt.Errorf("%s must be non-negative", setting.name)
		}
		*setting.target = value
	}
	return limits, nil
}
