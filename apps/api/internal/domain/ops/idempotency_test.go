package ops

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeDeclarationIdempotencyKey(t *testing.T) {
	t.Parallel()

	key, err := NormalizeDeclarationIdempotencyKey("  incident-abc-123 ")
	require.NoError(t, err)
	require.Equal(t, DeclarationIdempotencyKey("incident-abc-123"), key)

	empty, err := NormalizeDeclarationIdempotencyKey(" ")
	require.NoError(t, err)
	require.Equal(t, DeclarationIdempotencyKey(""), empty)
}

func TestParseSignalKeys(t *testing.T) {
	t.Parallel()

	resultKey, err := ParseMonitorResultKey("cf-monitor:run-1:api.health")
	require.NoError(t, err)
	require.Equal(t, MonitorResultKey("cf-monitor:run-1:api.health"), resultKey)

	eventKey, err := ParseHeartbeatEventKey("chalk-api:post_meeting.processor:run-1")
	require.NoError(t, err)
	require.Equal(t, HeartbeatEventKey("chalk-api:post_meeting.processor:run-1"), eventKey)
}

func TestBuildAutoDedupeKey(t *testing.T) {
	t.Parallel()

	key, err := BuildAutoDedupeKey(ComponentKeyAPI, "api.health")
	require.NoError(t, err)
	require.Equal(t, AutoDedupeKey("api:api.health"), key)
}

func TestDecideAutoOpenDedupe(t *testing.T) {
	t.Parallel()

	decision, err := DecideAutoOpenDedupe(nil)
	require.NoError(t, err)
	require.Equal(t, AutoOpenDedupeDecisionCreateIncident, decision)

	state := IncidentStateOpen
	decision, err = DecideAutoOpenDedupe(&state)
	require.NoError(t, err)
	require.Equal(t, AutoOpenDedupeDecisionAppendToIncident, decision)

	state = IncidentStateResolved
	decision, err = DecideAutoOpenDedupe(&state)
	require.NoError(t, err)
	require.Equal(t, AutoOpenDedupeDecisionCreateIncident, decision)
}
