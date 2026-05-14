package ops

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTransitionIncidentState_AllowedTransitions(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name string
		from IncidentState
		to   IncidentState
	}{
		{name: "open to monitoring", from: IncidentStateOpen, to: IncidentStateMonitoring},
		{name: "open to resolved", from: IncidentStateOpen, to: IncidentStateResolved},
		{name: "monitoring to resolved", from: IncidentStateMonitoring, to: IncidentStateResolved},
		{name: "monitoring to open", from: IncidentStateMonitoring, to: IncidentStateOpen},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			result, err := TransitionIncidentState(tc.from, tc.to)
			require.NoError(t, err)
			require.Equal(t, tc.from, result.From)
			require.Equal(t, tc.to, result.To)
			require.True(t, result.Changed)
			require.False(t, result.NoOp)
		})
	}
}

func TestTransitionIncidentState_NoOpTransition(t *testing.T) {
	t.Parallel()

	result, err := TransitionIncidentState(IncidentStateResolved, IncidentStateResolved)
	require.NoError(t, err)
	require.False(t, result.Changed)
	require.True(t, result.NoOp)
}

func TestTransitionIncidentState_RejectedTransitions(t *testing.T) {
	t.Parallel()

	_, err := TransitionIncidentState(IncidentStateResolved, IncidentStateOpen)
	require.ErrorIs(t, err, ErrInvalidIncidentTransition)

	_, err = TransitionIncidentState(IncidentStateResolved, IncidentStateMonitoring)
	require.ErrorIs(t, err, ErrInvalidIncidentTransition)
}

func TestShouldCreateNewIncidentOnRecurrence(t *testing.T) {
	t.Parallel()

	createNew, err := ShouldCreateNewIncidentOnRecurrence(IncidentStateResolved)
	require.NoError(t, err)
	require.True(t, createNew)

	createNew, err = ShouldCreateNewIncidentOnRecurrence(IncidentStateOpen)
	require.NoError(t, err)
	require.False(t, createNew)
}
