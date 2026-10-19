package config

import "testing"

func TestTenantLimitsConfig(t *testing.T) {
	for _, name := range []string{TenantMaxConcurrentRecordings, TenantDailyRecordingMinutes, TenantMaxLiveEpisodes} {
		t.Run(name, func(t *testing.T) {
			for _, value := range []string{"", "0", "1", "180", "-1", "invalid", "2147483648"} {
				t.Run(value, func(t *testing.T) {
					t.Setenv(name, value)
					_, err := Load()
					wantErr := value == "-1" || value == "invalid" || value == "2147483648"
					if (err != nil) != wantErr {
						t.Fatalf("value=%q error=%v", value, err)
					}
				})
			}
		})
	}
}
