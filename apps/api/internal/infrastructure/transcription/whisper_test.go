package transcription

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestNewWhisperProvider_TimeoutFromEnv(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "45m")

	provider := NewWhisperProvider(nil, "transcription:jobs")

	require.Equal(t, 45*time.Minute, provider.timeout)
}

func TestNewWhisperProvider_TimeoutFallsBackToDefault(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "not-a-duration")

	provider := NewWhisperProvider(nil, "transcription:jobs")

	require.Equal(t, whisperDefaultTimeout, provider.timeout)
}

func TestLoadWhisperTimeout_DefaultWhenUnset(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "")

	require.Equal(t, 2*time.Hour, loadWhisperTimeout())
}

func TestLoadWhisperTimeout_DefaultWhenNonPositive(t *testing.T) {
	t.Setenv(whisperTimeoutEnvVar, "0s")

	require.Equal(t, 2*time.Hour, loadWhisperTimeout())
}
