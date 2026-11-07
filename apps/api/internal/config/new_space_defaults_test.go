package config

import (
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/spaces"
)

func TestLoadNewSpaceDefaults(t *testing.T) {
	everyone, err := spaces.ParseChalkSFUAllowlist([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	ownSFU := ChalkSFUConfig{Enabled: true, AllowedSpaces: everyone}
	capturing := ChalkSFUConfig{Enabled: true, AllowedSpaces: everyone, CaptureEnabled: true}
	cases := []struct {
		name                         string
		plane, recording, transcript string
		sfu                          ChalkSFUConfig
		want                         spaces.NewSpaceDefaults
		wantErr                      bool
	}{
		{name: "everything unset"},
		{name: "cloudflare needs no own SFU", plane: "cf_sfu", want: spaces.NewSpaceDefaults{MediaPlane: spaces.MediaPlaneProviderCloudflareSFU}},
		{name: "own SFU while it is off", plane: "chalk_sfu", wantErr: true},
		{name: "own SFU with an allowlist short of everyone", plane: "chalk_sfu", sfu: ChalkSFUConfig{Enabled: true}, wantErr: true},
		{name: "own SFU for everyone without capture", plane: "chalk_sfu", sfu: ownSFU, want: spaces.NewSpaceDefaults{MediaPlane: spaces.MediaPlaneProviderChalkSFU}},
		{name: "own SFU with disabled policies needs no capture", plane: "chalk_sfu", recording: "disabled", transcript: "disabled", sfu: ownSFU, want: spaces.NewSpaceDefaults{MediaPlane: spaces.MediaPlaneProviderChalkSFU, RecordingPolicy: artifactpolicy.RecordingDisabled, TranscriptionPolicy: artifactpolicy.TranscriptionDisabled}},
		{name: "own SFU recording without capture", plane: "chalk_sfu", recording: "automatic", sfu: ownSFU, wantErr: true},
		{name: "own SFU transcription without capture", plane: "chalk_sfu", transcript: "automatic", sfu: ownSFU, wantErr: true},
		{name: "own SFU recording and transcription with capture", plane: "chalk_sfu", recording: "automatic", transcript: "automatic", sfu: capturing, want: spaces.NewSpaceDefaults{MediaPlane: spaces.MediaPlaneProviderChalkSFU, RecordingPolicy: artifactpolicy.RecordingAutomatic, TranscriptionPolicy: artifactpolicy.TranscriptionAutomatic}},
		{name: "policies alone ride on the deployment plane", recording: "automatic", want: spaces.NewSpaceDefaults{RecordingPolicy: artifactpolicy.RecordingAutomatic}},
		{name: "unknown plane", plane: "other", wantErr: true},
		{name: "unknown recording mode", recording: "always", wantErr: true},
		{name: "unknown transcription mode", transcript: "always", wantErr: true},
	}
	for _, c := range cases {
		t.Setenv(NewSpaceMediaPlane, c.plane)
		t.Setenv(NewSpaceRecordingPolicy, c.recording)
		t.Setenv(NewSpaceTranscriptionPolicy, c.transcript)
		got, err := loadNewSpaceDefaults(c.sfu)
		if (err != nil) != c.wantErr || got != c.want {
			t.Errorf("%s: got %+v, %v; want %+v, error %v", c.name, got, err, c.want, c.wantErr)
		}
	}
}
