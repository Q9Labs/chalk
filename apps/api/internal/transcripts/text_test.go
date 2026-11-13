package transcripts

import (
	"testing"
	"time"
)

func textCue(start, end int64, ref string, generation int64, displayName *string, text string) DocumentCue {
	return DocumentCue{
		StartMS: start, EndMS: end, Text: text,
		Identity: &DocumentCueIdentity{ParticipantRef: ref, ParticipantGeneration: generation, DisplayName: displayName},
	}
}

func TestFormatText(t *testing.T) {
	startedAt := time.Date(2026, 1, 2, 23, 0, 0, 0, time.UTC)
	cases := []struct {
		name     string
		document Document
		metadata TextMetadata
		want     string
	}{
		{
			"no speech with languages",
			Document{Language: ptr("fr")},
			TextMetadata{SpaceTitle: "T", StartedAt: startedAt, Duration: 45 * time.Second, Languages: []string{"en", "en", "und", "!!"}},
			"T · 2 Jan 2026 · 45 sec\nLanguages: English, French\n\nNo speech was transcribed.\n",
		},
		{
			"no languages",
			Document{},
			TextMetadata{SpaceTitle: "T", StartedAt: startedAt, Duration: 59 * time.Second},
			"T · 2 Jan 2026 · 59 sec\n\nNo speech was transcribed.\n",
		},
		{
			"minute duration",
			Document{},
			TextMetadata{SpaceTitle: "T", StartedAt: startedAt, Duration: time.Minute},
			"T · 2 Jan 2026 · 1 min\n\nNo speech was transcribed.\n",
		},
		{
			"rounded minutes",
			Document{},
			TextMetadata{SpaceTitle: "T", StartedAt: startedAt, Duration: 90 * time.Second},
			"T · 2 Jan 2026 · 2 min\n\nNo speech was transcribed.\n",
		},
		{
			"speakers merge split and sort",
			Document{Cues: []DocumentCue{
				textCue(12000, 13000, "b", 1, ptr("Bob"), "x"),
				textCue(0, 2000, "a", 1, nil, "Hi"),
				textCue(3700000, 3701000, "b", 1, ptr(" "), "late"),
				textCue(10000, 11000, "a", 1, nil, "again"),
				textCue(3000, 4000, "a", 1, nil, "there"),
			}},
			TextMetadata{SpaceTitle: "T", StartedAt: startedAt, Duration: 10 * time.Second},
			"T · 2 Jan 2026 · 10 sec\n\n" +
				"[00:00:00] Speaker 1: Hi there\n" +
				"[00:00:10] Speaker 1: again\n" +
				"[00:00:12] Bob: x\n" +
				"[01:01:40] Speaker 2: late\n",
		},
		{
			"equal starts keep artifact order and generations differ",
			Document{Cues: []DocumentCue{
				textCue(0, 1000, "a", 1, nil, "first"),
				textCue(0, 1000, "a", 1, nil, "second"),
				textCue(500, 1500, "a", 2, nil, "other"),
			}},
			TextMetadata{SpaceTitle: "T", StartedAt: startedAt, Duration: 10 * time.Second},
			"T · 2 Jan 2026 · 10 sec\n\n" +
				"[00:00:00] Speaker 1: first second\n" +
				"[00:00:00] Speaker 2: other\n",
		},
		{
			"gap measured from the end of the longest merged cue",
			Document{Cues: []DocumentCue{
				textCue(0, 10000, "a", 1, nil, "long"),
				textCue(11000, 12000, "a", 1, nil, "next"),
				textCue(17000, 18000, "a", 1, nil, "edge"),
				textCue(23001, 24000, "a", 1, nil, "far"),
			}},
			TextMetadata{SpaceTitle: "T", StartedAt: startedAt, Duration: 10 * time.Second},
			"T · 2 Jan 2026 · 10 sec\n\n" +
				"[00:00:00] Speaker 1: long next edge\n" +
				"[00:00:23] Speaker 1: far\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := FormatText(tc.document, tc.metadata); got != tc.want {
				t.Fatalf("got:\n%q\nwant:\n%q", got, tc.want)
			}
		})
	}
}
