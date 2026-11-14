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
	chalkSFU := ChalkSFUConfig{Enabled: true, AllowedSpaces: everyone}
	capturing := ChalkSFUConfig{Enabled: true, AllowedSpaces: everyone, CaptureEnabled: true}
	cases := []struct {
		name                         string
		plane, recording, transcript string
		sfu                          ChalkSFUConfig
		want                         spaces.NewSpaceDefaults
		wantErr                      string
	}{
		{name: "everything unset"},
		{name: "cloudflare needs no Chalk SFU", plane: "cf_sfu", want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderCloudflareSFU}},
		{name: "Chalk SFU while it is off", plane: "chalk_sfu", wantErr: "CHALK_NEW_SPACE_MEDIA_PLANE=chalk_sfu requires CHALK_SFU_ENABLED=true and CHALK_SFU_ALLOWED_SPACES=*"},
		{name: "Chalk SFU with an allowlist short of everyone", plane: "chalk_sfu", sfu: ChalkSFUConfig{Enabled: true}, wantErr: "requires CHALK_SFU_ENABLED=true and CHALK_SFU_ALLOWED_SPACES=*"},
		{name: "Chalk SFU with inherited automatic policies and no capture", plane: "chalk_sfu", sfu: chalkSFU, wantErr: "need CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "Chalk SFU with inherited automatic policies and capture", plane: "chalk_sfu", sfu: capturing, want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderChalkSFU}},
		{name: "Chalk SFU with disabled policies needs no capture", plane: "chalk_sfu", recording: "disabled", transcript: "disabled", sfu: chalkSFU, want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderChalkSFU, RecordingPolicy: artifactpolicy.RecordingDisabled, TranscriptionPolicy: artifactpolicy.TranscriptionDisabled}},
		{name: "Chalk SFU with one policy disabled still inherits the other", plane: "chalk_sfu", recording: "disabled", sfu: chalkSFU, wantErr: "need CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "Chalk SFU recording without capture", plane: "chalk_sfu", recording: "automatic", sfu: chalkSFU, wantErr: "CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "Chalk SFU transcription without capture", plane: "chalk_sfu", transcript: "automatic", sfu: chalkSFU, wantErr: "CHALK_SFU_CAPTURE_ENABLED=true"},
		{name: "Chalk SFU recording and transcription with capture", plane: "chalk_sfu", recording: "automatic", transcript: "automatic", sfu: capturing, want: spaces.NewSpaceDefaults{MediaPlane: mediaplane.ProviderChalkSFU, RecordingPolicy: artifactpolicy.RecordingAutomatic, TranscriptionPolicy: artifactpolicy.TranscriptionAutomatic}},
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
