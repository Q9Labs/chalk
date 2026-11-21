package config

import (
	"fmt"
	"os"
	"strings"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

const (
	CloudflareTurnKeyID         = "CHALK_CLOUDFLARE_TURN_KEY_ID"
	CloudflareTurnAPIToken      = "CHALK_CLOUDFLARE_TURN_API_TOKEN"
	NewSpaceRecordingPolicy     = "CHALK_NEW_SPACE_RECORDING_POLICY"
	NewSpaceTranscriptionPolicy = "CHALK_NEW_SPACE_TRANSCRIPTION_POLICY"
)

// CloudflareTURNConfig configures the relay for Chalk SFU clients, not signaling.
type CloudflareTURNConfig struct {
	TurnKeyID    string
	TurnAPIToken string
}

func (cfg *Config) loadMedia() error {
	cfg.TURN = CloudflareTURNConfig{
		TurnKeyID:    envOrDefault(CloudflareTurnKeyID, ""),
		TurnAPIToken: envOrDefault(CloudflareTurnAPIToken, ""),
	}
	if (cfg.TURN.TurnKeyID == "") != (cfg.TURN.TurnAPIToken == "") {
		return fmt.Errorf("%s and %s must be set together", CloudflareTurnKeyID, CloudflareTurnAPIToken)
	}
	var err error
	cfg.ChalkSFU, err = loadChalkSFUConfig()
	if err != nil {
		return err
	}
	cfg.NewSpace, err = loadNewSpaceDefaults()
	return err
}

func loadNewSpaceDefaults() (spaces.NewSpaceDefaults, error) {
	var defaults spaces.NewSpaceDefaults
	if value := strings.TrimSpace(os.Getenv(NewSpaceRecordingPolicy)); value != "" {
		defaults.RecordingPolicy = artifactpolicy.RecordingMode(value)
		if err := defaults.RecordingPolicy.Validate(); err != nil {
			return spaces.NewSpaceDefaults{}, fmt.Errorf("%s: %w", NewSpaceRecordingPolicy, err)
		}
	}
	if value := strings.TrimSpace(os.Getenv(NewSpaceTranscriptionPolicy)); value != "" {
		defaults.TranscriptionPolicy = artifactpolicy.TranscriptionMode(value)
		if err := defaults.TranscriptionPolicy.Validate(); err != nil {
			return spaces.NewSpaceDefaults{}, fmt.Errorf("%s: %w", NewSpaceTranscriptionPolicy, err)
		}
	}
	return defaults, nil
}
