package httpapi

import "testing"

func TestRecordingAudioFormatUsesParsedContentType(t *testing.T) {
	tests := []struct {
		name        string
		storageKey  string
		contentType string
		want        string
	}{
		{
			name:        "webm video content type with parameters",
			storageKey:  "tenants/11111111-1111-1111-1111-111111111111/recordings/meeting",
			contentType: "video/webm; codecs=opus",
			want:        "webm",
		},
		{
			name:        "mp4 video content type without extension",
			storageKey:  "tenants/11111111-1111-1111-1111-111111111111/recordings/meeting",
			contentType: "video/mp4",
			want:        "mp4",
		},
		{
			name:        "extension wins",
			storageKey:  "tenants/11111111-1111-1111-1111-111111111111/recordings/meeting.wav",
			contentType: "video/mp4",
			want:        "wav",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := recordingAudioFormat(test.storageKey, test.contentType)
			if got != test.want {
				t.Fatalf("format = %q, want %q", got, test.want)
			}
		})
	}
}
