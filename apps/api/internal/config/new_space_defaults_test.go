package config

import (
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/artifactpolicy"
	"github.com/q9labs/chalk/apps/api/internal/mediaplane"
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
		wantErr                      string
	}{
		{name: "everything unset"},
		{name: "cloudflare needs no own SFU", plane: "cf_sfu", want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderCloudflareSFU}},
		{name: "own SFU while it is off", plane: "chalk_sfu", wantErr: "CHALK_NEW_SPACE_MEDIA_PLANE=chalk_sfu requires CHALK_SFU_ENABLED=true and CHALK_SFU_ALLOWED_SPACES=*"},
		{name: "own SFU with an allowlist short of everyone", plane: "chalk_sfu", sfu: ChalkSFUConfig{Enabled: true}, wantErr: "requires CHALK_SFU_ENABLED=true and CHALK_SFU_ALLOWED_SPACES=*"},
		{name: "own SFU with inherited automatic policies and no capture", plane: "chalk_sfu", sfu: ownSFU, wantErr: "need CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "own SFU with inherited automatic policies and capture", plane: "chalk_sfu", sfu: capturing, want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderChalkSFU}},
		{name: "own SFU with disabled policies needs no capture", plane: "chalk_sfu", recording: "disabled", transcript: "disabled", sfu: ownSFU, want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderChalkSFU, RecordingPolicy: artifactpolicy.RecordingDisabled, TranscriptionPolicy: artifactpolicy.TranscriptionDisabled}},
		{name: "own SFU with one policy disabled still inherits the other", plane: "chalk_sfu", recording: "disabled", sfu: ownSFU, wantErr: "need CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "own SFU recording without capture", plane: "chalk_sfu", recording: "automatic", sfu: ownSFU, wantErr: "CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "own SFU transcription without capture", plane: "chalk_sfu", transcript: "automatic", sfu: ownSFU, wantErr: "CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "own SFU recording and transcription with capture", plane: "chalk_sfu", recording: "automatic", transcript: "automatic", sfu: capturing, want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderChalkSFU, RecordingPolicy: artifactpolicy.RecordingAutomatic, TranscriptionPolicy: artifactpolicy.TranscriptionAutomatic}},
		{name: "policies alone ride on the deployment plane", recording: "automatic", want: spaces.NewSpaceDefaults{RecordingPolicy: artifactpolicy.RecordingAutomatic}},
		{name: "unknown plane", plane: "other", wantErr: "CHALK_NEW_SPACE_MEDIA_PLANE"},
		{name: "unknown recording mode", recording: "always", wantErr: "CHALK_NEW_SPACE_RECORDING_POLICY"},
		{name: "unknown transcription mode", transcript: "always", wantErr: "CHALK_NEW_SPACE_TRANSCRIPTION_POLICY"},
	}
	for _, c := range cases {
		t.Setenv(NewSpaceMediaPlane, c.plane)
		t.Setenv(NewSpaceRecordingPolicy, c.recording)
		t.Setenv(NewSpaceTranscriptionPolicy, c.transcript)
		got, err := loadNewSpaceDefaults(c.sfu)
		if c.wantErr != "" {
			if err == nil || !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("%s: got error %v; want one containing %q", c.name, err, c.wantErr)
			}
			continue
		}
		if err != nil || got != c.want {
			t.Errorf("%s: got %+v, %v; want %+v", c.name, got, err, c.want)
		}
	}
}
