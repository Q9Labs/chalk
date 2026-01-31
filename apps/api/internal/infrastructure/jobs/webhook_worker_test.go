package jobs

import (
	"testing"

	"github.com/Q9Labs/chalk/internal/domain/webhook"
)

func TestMinInt(t *testing.T) {
	tests := []struct {
		a, b     int
		expected int
	}{
		{1, 2, 1},
		{5, 3, 3},
		{0, 0, 0},
		{-1, 1, -1},
	}

	for _, tc := range tests {
		result := minInt(tc.a, tc.b)
		if result != tc.expected {
			t.Errorf("minInt(%d, %d) = %d, want %d", tc.a, tc.b, result, tc.expected)
		}
	}
}

func TestExtractWebhookSecret(t *testing.T) {
	tests := []struct {
		name     string
		config   []byte
		expected string
		wantErr  bool
	}{
		{
			name:     "nil config",
			config:   nil,
			expected: "",
			wantErr:  false,
		},
		{
			name:     "empty config",
			config:   []byte("{}"),
			expected: "",
			wantErr:  false,
		},
		{
			name:     "config without webhook",
			config:   []byte(`{"some_other_key": "value"}`),
			expected: "",
			wantErr:  false,
		},
		{
			name:     "config with webhook but no secret",
			config:   []byte(`{"post_meeting_webhook": {"enabled": true}}`),
			expected: "",
			wantErr:  false,
		},
		{
			name:     "config with webhook and secret",
			config:   []byte(`{"post_meeting_webhook": {"enabled": true, "secret": "whsec_test123"}}`),
			expected: "whsec_test123",
			wantErr:  false,
		},
		{
			name:     "invalid json",
			config:   []byte(`{invalid json`),
			expected: "",
			wantErr:  true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			secret, err := webhook.ExtractWebhookSecret(tc.config)
			if (err != nil) != tc.wantErr {
				t.Errorf("extractWebhookSecret() error = %v, wantErr %v", err, tc.wantErr)
				return
			}
			if secret != tc.expected {
				t.Errorf("extractWebhookSecret() = %q, want %q", secret, tc.expected)
			}
		})
	}
}
