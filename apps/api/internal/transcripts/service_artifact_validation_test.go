package transcripts

import (
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func TestPrepareRequestInputReservesChunkJobSuffix(t *testing.T) {
	key := strings.Repeat("k", maxRequestIdempotencyKeySize)
	input := validRequestInputForValidation(key, maxTranscriptionChunks)
	if err := prepareRequestInput(&input); err != nil {
		t.Fatalf("maximum supported chunk request rejected: %v", err)
	}

	tooLong := validRequestInputForValidation(strings.Repeat("k", maxRequestIdempotencyKeySize+1), 1)
	if err := prepareRequestInput(&tooLong); !errors.Is(err, ErrInvalidIdempotencyKey) {
		t.Fatalf("oversized derived job key error = %v, want ErrInvalidIdempotencyKey", err)
	}
}

func validRequestInputForValidation(key string, chunkCount int) RequestInput {
	tenantID, _ := utilities.NewID()
	recordingID, _ := utilities.NewID()
	chunks := make([]ChunkInput, chunkCount)
	for index := range chunks {
		chunks[index] = ChunkInput{
			Index:       index,
			Generation:  1,
			StartMS:     int64(index) * 1000,
			EndMS:       int64(index+1) * 1000,
			StorageKey:  "chunks/" + string(rune('a'+index%26)) + ".wav",
			Checksum:    make([]byte, 32),
			Size:        1,
			ContentType: "audio/wav",
		}
	}
	return RequestInput{
		TenantID:            tenantID,
		RecordingID:         recordingID,
		IdempotencyKey:      key,
		ManifestKey:         "manifest.json",
		ManifestSHA256:      make([]byte, 32),
		ManifestSize:        1,
		ManifestContentType: "application/json",
		Chunks:              chunks,
	}
}
