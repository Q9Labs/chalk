package ops

import (
	"testing"
	"time"

	domainops "github.com/Q9Labs/chalk/internal/domain/ops"
	"github.com/stretchr/testify/require"
)

func TestNewStaticCatalog(t *testing.T) {
	t.Parallel()

	catalog, err := NewStaticCatalog()
	require.NoError(t, err)

	components := catalog.Components()
	require.Len(t, components, 4)

	apiComponent, ok := catalog.Component(domainops.ComponentKeyAPI)
	require.True(t, ok)
	require.Equal(t, "API", apiComponent.DisplayName)

	apiHealth, ok := catalog.Monitor(domainops.MonitorKeyAPIHealth)
	require.True(t, ok)
	require.Equal(t, domainops.IncidentSeverityCritical, apiHealth.Severity)
	require.Equal(t, 3, apiHealth.AutoOpenConsecutiveFailures)
	require.Equal(t, time.Minute, apiHealth.ExpectedInterval)

	webhookWorker, ok := catalog.Heartbeat(domainops.HeartbeatKeyWebhookDeliveryWorker)
	require.True(t, ok)
	require.Equal(t, domainops.IncidentSeverityCritical, webhookWorker.Severity)
	require.Equal(t, time.Minute, webhookWorker.ExpectedInterval)
	require.Equal(t, 3*time.Minute, webhookWorker.GraceWindow)
	require.True(t, webhookWorker.AutoOpenOnMiss)
}

func TestDefaultHeartbeatGraceWindow(t *testing.T) {
	t.Parallel()

	require.Equal(t, 3*time.Minute, DefaultHeartbeatGraceWindow(time.Minute))
	require.Equal(t, 12*time.Minute, DefaultHeartbeatGraceWindow(5*time.Minute))
	require.Equal(t, 75*time.Minute, DefaultHeartbeatGraceWindow(time.Hour))
	require.Equal(t, 75*time.Minute, DefaultHeartbeatGraceWindow(6*time.Hour))
}
