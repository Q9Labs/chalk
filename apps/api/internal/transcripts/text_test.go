package transcripts

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestFormatTextFixture(t *testing.T) {
	artifact, err := os.Open("testdata/text-transcript.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	defer artifact.Close()
	document, err := ReadDocument(artifact, MaxDocumentBytes)
	if err != nil {
		t.Fatal(err)
	}
	text := FormatText(document, textTestMetadata())
	expected, err := os.ReadFile("testdata/transcript.txt")
	if err != nil {
		t.Fatal(err)
	}
	if text != string(expected) {
		t.Fatalf("text export =\n%s\nwant:\n%s", text, expected)
	}
}

func TestFormatTextSpeakerGrouping(t *testing.T) {
	for _, test := range []struct {
		name string
		cues []DocumentCue
		want string
	}{
		{"sorts without mutating and merges at five seconds", []DocumentCue{textTestCue(7000, 8000, "p1", 1, "A", "second"), textTestCue(1000, 2000, "p1", 1, "A", "first")}, "[00:00:01] A: first second\n"},
		{"splits beyond five seconds", []DocumentCue{textTestCue(1000, 2000, "p1", 1, "A", "first"), textTestCue(7001, 8000, "p1", 1, "A", "second")}, "[00:00:01] A: first\n[00:00:07] A: second\n"},
		{"equal names do not merge identities", []DocumentCue{textTestCue(1000, 2000, "p1", 1, "A", "first"), textTestCue(2000, 3000, "p2", 1, "A", "second")}, "[00:00:01] A: first\n[00:00:02] A: second\n"},
		{"participant generation distinguishes speakers", []DocumentCue{textTestCue(1000, 2000, "p1", 1, "", "first"), textTestCue(2000, 3000, "p1", 2, "", "second"), textTestCue(3000, 4000, "p1", 1, "", "third")}, "[00:00:01] Speaker 1: first\n[00:00:02] Speaker 2: second\n[00:00:03] Speaker 1: third\n"},
		{"overlap retains furthest end", []DocumentCue{textTestCue(1000, 9000, "p1", 1, "A", "first"), textTestCue(2000, 3000, "p1", 1, "A", "second"), textTestCue(14000, 15000, "p1", 1, "A", "third")}, "[00:00:01] A: first second third\n"},
		{"UTF-8 text is unchanged", []DocumentCue{textTestCue(3604000, 3605000, "p1", 1, "حسن", "آئیے شروع کریں۔ مرحباً بالعالم")}, "[01:00:04] حسن: آئیے شروع کریں۔ مرحباً بالعالم\n"},
		{"equal starts preserve order", []DocumentCue{textTestCue(1000, 2000, "p1", 1, "A", "first"), textTestCue(1000, 2000, "p2", 1, "B", "second")}, "[00:00:01] A: first\n[00:00:01] B: second\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			firstStart := test.cues[0].StartMS
			text := FormatText(Document{Cues: test.cues}, textTestMetadata())
			if !strings.HasSuffix(text, "\n\n"+test.want) || test.cues[0].StartMS != firstStart {
				t.Fatalf("export = %q; want lines %q without mutating cues", text, test.want)
			}
		})
	}
}

func TestFormatTextEmptyAndUnknownLanguages(t *testing.T) {
	for _, value := range []string{"", "und", "not a language"} {
		text := FormatText(Document{Language: &value}, textTestMetadata())
		if text != "Release planning · 1 Nov 2026 · 42 min\n\nNo speech was transcribed.\n" {
			t.Fatalf("empty export = %q", text)
		}
	}
	value := "ur"
	if text := FormatText(Document{Language: &value}, textTestMetadata()); !strings.Contains(text, "Languages: Urdu\n") {
		t.Fatalf("language missing: %q", text)
	}
}

func textTestMetadata() TextMetadata {
	return TextMetadata{SpaceTitle: "Release planning", StartedAt: time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), Duration: 42 * time.Minute}
}

func textTestCue(start, end int64, ref string, generation int64, name, text string) DocumentCue {
	return DocumentCue{StartMS: start, EndMS: end, Text: text, Identity: &DocumentCueIdentity{ParticipantRef: ref, ParticipantGeneration: generation, DisplayName: &name}}
}
