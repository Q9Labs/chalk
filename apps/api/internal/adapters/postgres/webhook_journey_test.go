package postgres

import "testing"

func TestWebhookJourneyPhaseMarksOnlyTerminalStates(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"committed":  "webhook",
		"queued":     "webhook",
		"started":    "webhook",
		"retry_wait": "webhook",
		"succeeded":  "terminal",
		"exhausted":  "terminal",
		"cancelled":  "terminal",
		"canceled":   "webhook",
		"erased":     "terminal",
	}
	for state, want := range tests {
		if got := webhookJourneyPhase(state); got != want {
			t.Errorf("phase for state %q = %q, want %q", state, got, want)
		}
	}
}
