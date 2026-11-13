package transcripts

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

type recordingFinalizer struct {
	FinalizerRepository
	got   FinalizerCompleteInput
	calls int
}

func (f *recordingFinalizer) CompleteFinalizer(_ context.Context, input FinalizerCompleteInput) (Transcript, error) {
	f.calls++
	f.got = input
	return Transcript{}, nil
}

func validFinalizerInput(t *testing.T) FinalizerCompleteInput {
	return FinalizerCompleteInput{
		JobID: testID(t), Attempt: 1, LeaseToken: "token", Provider: "p", Model: "m", VersionContract: "v",
		ArtifactSHA256: make([]byte, 32), ArtifactSize: 10, ArtifactContentType: "application/json",
	}
}

func TestCompleteFinalizer(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*FinalizerCompleteInput)
		want   error
	}{
		{"valid", func(*FinalizerCompleteInput) {}, nil},
		{"zero job", func(i *FinalizerCompleteInput) { i.JobID = utilities.ID{} }, ErrInvalidArtifact},
		{"zero attempt", func(i *FinalizerCompleteInput) { i.Attempt = 0 }, ErrInvalidArtifact},
		{"empty token", func(i *FinalizerCompleteInput) { i.LeaseToken = "" }, ErrInvalidArtifact},
		{"short sha", func(i *FinalizerCompleteInput) { i.ArtifactSHA256 = make([]byte, 31) }, ErrInvalidArtifact},
		{"zero size", func(i *FinalizerCompleteInput) { i.ArtifactSize = 0 }, ErrInvalidArtifact},
		{"max size", func(i *FinalizerCompleteInput) { i.ArtifactSize = 524288000 }, nil},
		{"over size", func(i *FinalizerCompleteInput) { i.ArtifactSize = 524288001 }, ErrInvalidArtifact},
		{"content type", func(i *FinalizerCompleteInput) { i.ArtifactContentType = "text/plain" }, ErrInvalidArtifact},
		{"empty provider", func(i *FinalizerCompleteInput) { i.Provider = "" }, ErrInvalidArtifact},
		{"long provider", func(i *FinalizerCompleteInput) { i.Provider = strings.Repeat("a", 129) }, ErrInvalidArtifact},
		{"empty model", func(i *FinalizerCompleteInput) { i.Model = "" }, ErrInvalidArtifact},
		{"long model", func(i *FinalizerCompleteInput) { i.Model = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"empty version", func(i *FinalizerCompleteInput) { i.VersionContract = "" }, ErrInvalidArtifact},
		{"long version", func(i *FinalizerCompleteInput) { i.VersionContract = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"long execution identity", func(i *FinalizerCompleteInput) { i.ExecutionIdentity = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"long request id", func(i *FinalizerCompleteInput) { i.ProviderRequestID = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"invalid quality", func(i *FinalizerCompleteInput) { i.Quality = json.RawMessage(`{`) }, ErrInvalidArtifact},
		{"oversize quality", func(i *FinalizerCompleteInput) {
			i.Quality = json.RawMessage(`"` + strings.Repeat("a", 16384) + `"`)
		}, ErrInvalidArtifact},
		{"valid quality", func(i *FinalizerCompleteInput) { i.Quality = json.RawMessage(`{"a":1}`) }, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			repo := &recordingFinalizer{}
			input := validFinalizerInput(t)
			tc.mutate(&input)
			_, err := Service{finalizer: repo}.CompleteFinalizer(context.Background(), input)
			if !errors.Is(err, tc.want) || (tc.want == nil) != (err == nil) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
			if wantCalls := map[bool]int{true: 1, false: 0}[tc.want == nil]; repo.calls != wantCalls {
				t.Fatalf("repository calls = %d, want %d", repo.calls, wantCalls)
			}
		})
	}

	repo := &recordingFinalizer{}
	if _, err := (Service{finalizer: repo}).CompleteFinalizer(context.Background(), validFinalizerInput(t)); err != nil {
		t.Fatal(err)
	}
	if string(repo.got.Quality) != `{}` {
		t.Fatalf("quality default = %q", repo.got.Quality)
	}
	if _, err := (Service{}).CompleteFinalizer(context.Background(), validFinalizerInput(t)); !errors.Is(err, ErrArtifactRepository) {
		t.Fatalf("error = %v", err)
	}
}
