package ops

import (
	"testing"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/stretchr/testify/require"
)

func TestConsecutiveMonitorFailures(t *testing.T) {
	t.Parallel()

	count := ConsecutiveMonitorFailures([]domainops.MonitorResultStatus{
		domainops.MonitorResultStatusFailed,
		domainops.MonitorResultStatusFailed,
		domainops.MonitorResultStatusOK,
		domainops.MonitorResultStatusFailed,
	})
	require.Equal(t, 2, count)
}

func TestIsHeartbeatMissed(t *testing.T) {
	t.Parallel()

	lastSeen := time.Now().Add(-5 * time.Minute)
	missed := IsHeartbeatMissed(lastSeen, time.Now(), time.Minute, 3*time.Minute)
	require.True(t, missed)
}

func TestIsEventWithinSkew(t *testing.T) {
	t.Parallel()

	now := time.Now()
	require.True(t, IsEventWithinSkew(now.Add(-30*time.Second), now, time.Minute, 10*time.Second))
	require.False(t, IsEventWithinSkew(now.Add(-2*time.Minute), now, time.Minute, 10*time.Second))
	require.False(t, IsEventWithinSkew(now.Add(20*time.Second), now, time.Minute, 10*time.Second))
}
