package transcripts

import "testing"

func TestPrepareRequestInputAllowsNeutralLanguageHints(t *testing.T) {
	for name, languages := range map[string][]string{
		"omitted": nil,
		"empty":   {},
	} {
		t.Run(name, func(t *testing.T) {
			input := RequestInput{
				TenantID:       mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000001"),
				RecordingID:    mustTranscriptTestID(t, "00000000-0000-4000-8000-000000000002"),
				IdempotencyKey: "request-00000001",
				Languages:      languages,
			}
			if err := prepareRequestInput(&input); err != nil {
				t.Fatalf("prepare neutral language hints: %v", err)
			}
			if input.Language != "" || len(input.Languages) != 0 {
				t.Fatalf("prepared language hints = language %q, languages %#v", input.Language, input.Languages)
			}
		})
	}
}
