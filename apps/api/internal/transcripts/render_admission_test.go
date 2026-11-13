package transcripts

import (
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func validSourceChunk(t *testing.T) ChunkInput {
	return ChunkInput{
		ID: testID(t), Index: 2, Generation: 5,
		StartMS: 1000, EndMS: 2000, SourceStartMS: 10, SourceEndMS: 1010,
		ParticipantRef: "p", ParticipantGeneration: 1, TrackID: "t", TrackEpoch: "e",
		IdentityKind: "participant", TrackClass: "microphone", DisplayNameSnapshot: "Name",
		StorageKey: "a/b.flac", AllocationID: testID(t), ObjectETag: "etag",
		Checksum: make([]byte, 32), Size: 10, ContentType: "audio/flac",
	}
}

func TestPrepareSourceChunk(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*ChunkInput)
		want   error
	}{
		{"valid", func(*ChunkInput) {}, nil},
		{"zero id", func(c *ChunkInput) { c.ID = utilities.ID{} }, ErrInvalidChunk},
		{"wrong index", func(c *ChunkInput) { c.Index = 3 }, ErrInvalidChunk},
		{"wrong generation", func(c *ChunkInput) { c.Generation = 4 }, ErrInvalidChunk},
		{"negative start", func(c *ChunkInput) { c.StartMS = -1; c.SourceEndMS = 1011 }, ErrInvalidChunk},
		{"end equals start", func(c *ChunkInput) { c.EndMS = 1000 }, ErrInvalidChunk},
		{"end before start", func(c *ChunkInput) { c.EndMS = 999 }, ErrInvalidChunk},
		{"too long", func(c *ChunkInput) { c.EndMS = 1000 + 15*60*1000 + 1; c.SourceEndMS = c.SourceStartMS + 15*60*1000 + 1 }, ErrInvalidChunk},
		{"max length", func(c *ChunkInput) { c.EndMS = 1000 + 15*60*1000; c.SourceEndMS = c.SourceStartMS + 15*60*1000 }, nil},
		{"negative source start", func(c *ChunkInput) { c.SourceStartMS = -1; c.SourceEndMS = 999 }, ErrInvalidChunk},
		{"source end equals start", func(c *ChunkInput) { c.SourceEndMS = 10 }, ErrInvalidChunk},
		{"source length mismatch", func(c *ChunkInput) { c.SourceEndMS = 1011 }, ErrInvalidChunk},
		{"zero allocation", func(c *ChunkInput) { c.AllocationID = utilities.ID{} }, ErrInvalidChunk},
		{"bad key", func(c *ChunkInput) { c.StorageKey = "/a" }, ErrInvalidChunk},
		{"empty key", func(c *ChunkInput) { c.StorageKey = "" }, ErrInvalidChunk},
		{"short checksum", func(c *ChunkInput) { c.Checksum = make([]byte, 31) }, ErrInvalidChunk},
		{"zero size", func(c *ChunkInput) { c.Size = 0 }, ErrInvalidChunk},
		{"over size", func(c *ChunkInput) { c.Size = 524288001 }, ErrInvalidChunk},
		{"max size", func(c *ChunkInput) { c.Size = 524288000 }, nil},
		{"content type", func(c *ChunkInput) { c.ContentType = "audio/wav" }, ErrInvalidChunk},
		{"long participant ref", func(c *ChunkInput) { c.ParticipantRef = strings.Repeat("a", 129) }, ErrInvalidChunk},
		{"max participant ref", func(c *ChunkInput) { c.ParticipantRef = strings.Repeat("a", 128) }, nil},
		{"long track id", func(c *ChunkInput) { c.TrackID = strings.Repeat("a", 257) }, ErrInvalidChunk},
		{"long track epoch", func(c *ChunkInput) { c.TrackEpoch = strings.Repeat("a", 129) }, ErrInvalidChunk},
		{"long display name", func(c *ChunkInput) { c.DisplayNameSnapshot = strings.Repeat("a", 257) }, ErrInvalidChunk},
		{"long object version", func(c *ChunkInput) { c.ObjectVersion = strings.Repeat("a", 257) }, ErrInvalidChunk},
		{"empty etag", func(c *ChunkInput) { c.ObjectETag = "" }, ErrInvalidChunk},
		{"long etag", func(c *ChunkInput) { c.ObjectETag = strings.Repeat("a", 257) }, ErrInvalidChunk},
		{"identity kind", func(c *ChunkInput) { c.IdentityKind = "guest" }, ErrInvalidChunk},
		{"track class", func(c *ChunkInput) { c.TrackClass = "screen" }, ErrInvalidChunk},
		{"empty participant ref", func(c *ChunkInput) { c.ParticipantRef = "" }, ErrInvalidChunk},
		{"zero participant generation", func(c *ChunkInput) { c.ParticipantGeneration = 0 }, ErrInvalidChunk},
		{"empty track id", func(c *ChunkInput) { c.TrackID = "" }, ErrInvalidChunk},
		{"empty track epoch", func(c *ChunkInput) { c.TrackEpoch = "" }, ErrInvalidChunk},
		{"empty display name", func(c *ChunkInput) { c.DisplayNameSnapshot = "" }, ErrInvalidChunk},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			chunk := validSourceChunk(t)
			tc.mutate(&chunk)
			err := prepareSourceChunk(&chunk, 2, 5)
			if !errors.Is(err, tc.want) || (tc.want == nil) != (err == nil) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}
