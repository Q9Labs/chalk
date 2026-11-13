package transcripts

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/utilities"
)

func testID(t *testing.T) utilities.ID {
	t.Helper()
	id, err := utilities.NewID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func validRequestInput(t *testing.T) RequestInput {
	return RequestInput{TenantID: testID(t), RecordingID: testID(t), IdempotencyKey: "key-1"}
}

func TestPrepareRequestInput(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*RequestInput)
		want   error
	}{
		{"valid", func(*RequestInput) {}, nil},
		{"zero tenant", func(i *RequestInput) { i.TenantID = utilities.ID{} }, ErrInvalidTenantID},
		{"zero recording", func(i *RequestInput) { i.RecordingID = utilities.ID{} }, ErrInvalidRecordingID},
		{"blank key", func(i *RequestInput) { i.IdempotencyKey = "  " }, ErrInvalidIdempotencyKey},
		{"long key", func(i *RequestInput) { i.IdempotencyKey = strings.Repeat("a", maxRequestIdempotencyKeySize+1) }, ErrInvalidIdempotencyKey},
		{"max key", func(i *RequestInput) { i.IdempotencyKey = strings.Repeat("a", maxRequestIdempotencyKeySize) }, nil},
		{"bad key char", func(i *RequestInput) { i.IdempotencyKey = "a b" }, ErrInvalidIdempotencyKey},
		{"bad key slash", func(i *RequestInput) { i.IdempotencyKey = "a/b" }, ErrInvalidIdempotencyKey},
		{"key all allowed chars", func(i *RequestInput) { i.IdempotencyKey = "aZ09._-" }, nil},
		{"trimmed key", func(i *RequestInput) { i.IdempotencyKey = "  abc  " }, nil},
		{"unknown language", func(i *RequestInput) { i.Language = "xx" }, ErrInvalidLanguages},
		{"auto language", func(i *RequestInput) { i.Language = "auto" }, nil},
		{"fixed language", func(i *RequestInput) { i.Language = "en" }, nil},
		{"language mismatch list", func(i *RequestInput) { i.Language = "en"; i.Languages = []string{"fr"} }, ErrInvalidLanguages},
		{"language matching list", func(i *RequestInput) { i.Language = "en"; i.Languages = []string{"en"} }, nil},
		{"language with longer list", func(i *RequestInput) { i.Language = "en"; i.Languages = []string{"en", "en"} }, ErrInvalidLanguages},
		{"too many languages", func(i *RequestInput) {
			i.Languages = []string{"en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en"}
		}, ErrInvalidLanguages},
		{"sixteen languages", func(i *RequestInput) {
			i.Languages = []string{"en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en", "en"}
		}, nil},
		{"blank list entry", func(i *RequestInput) { i.Languages = []string{" "} }, ErrInvalidLanguages},
		{"long list entry", func(i *RequestInput) { i.Languages = []string{strings.Repeat("a", 33)} }, ErrInvalidLanguages},
		{"unknown list entry", func(i *RequestInput) { i.Languages = []string{"en", "zz"} }, ErrInvalidLanguages},
		{"padded list entry", func(i *RequestInput) { i.Languages = []string{" en "} }, nil},
		{"long traceparent", func(i *RequestInput) { i.Traceparent = strings.Repeat("a", 257) }, ErrInvalidTranscriptField},
		{"max traceparent", func(i *RequestInput) { i.Traceparent = strings.Repeat("a", 256) }, nil},
		{"long tracestate", func(i *RequestInput) { i.Tracestate = strings.Repeat("a", 513) }, ErrInvalidTranscriptField},
		{"max tracestate", func(i *RequestInput) { i.Tracestate = strings.Repeat("a", 512) }, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := validRequestInput(t)
			tc.mutate(&input)
			err := prepareRequestInput(&input)
			if !errors.Is(err, tc.want) || (tc.want == nil) != (err == nil) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestPrepareRequestInputNormalizes(t *testing.T) {
	input := validRequestInput(t)
	input.IdempotencyKey = "  abc  "
	input.Priority = 9
	input.AttemptLimit = 99
	input.Language = "en"
	if err := prepareRequestInput(&input); err != nil {
		t.Fatal(err)
	}
	if input.IdempotencyKey != "abc" || input.Priority != 0 || input.AttemptLimit != 4 {
		t.Fatalf("unexpected normalization: %+v", input)
	}
	if !reflect.DeepEqual(input.Languages, []string{"en"}) {
		t.Fatalf("languages = %v", input.Languages)
	}
	if input.Now.IsZero() {
		t.Fatal("Now not defaulted")
	}

	fixed := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	input = validRequestInput(t)
	input.Languages = []string{" en ", " fr"}
	input.Now = fixed
	if err := prepareRequestInput(&input); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(input.Languages, []string{"en", "fr"}) || !input.Now.Equal(fixed) {
		t.Fatalf("unexpected normalization: %+v", input)
	}

	// A rejected request still carries the release policy and trimmed key.
	input = validRequestInput(t)
	input.IdempotencyKey = " abc "
	input.Priority = 7
	input.Language = "zz"
	if err := prepareRequestInput(&input); !errors.Is(err, ErrInvalidLanguages) {
		t.Fatal(err)
	}
	if input.IdempotencyKey != "abc" || input.Priority != 0 || input.AttemptLimit != 4 {
		t.Fatalf("unexpected partial mutation: %+v", input)
	}
}

func validResultInput(t *testing.T) ResultInput {
	return ResultInput{
		JobID: testID(t), Attempt: 1, LeaseOwner: "owner", LeaseToken: "token",
		ResultSHA256: make([]byte, 32), ResultSize: 10, ResultContentType: "application/json",
		Provider: "deepinfra", Model: "m", ProviderVersion: "v",
	}
}

func TestPrepareResultInput(t *testing.T) {
	neg := -1
	big := 86401
	okInt := 86400
	negMS := int64(-1)
	bigMS := int64(86400001)
	okMS := int64(86400000)
	cases := []struct {
		name   string
		mutate func(*ResultInput)
		want   error
	}{
		{"valid", func(*ResultInput) {}, nil},
		{"lease invalid", func(i *ResultInput) { i.LeaseToken = "" }, ErrInvalidLease},
		{"zero job", func(i *ResultInput) { i.JobID = utilities.ID{} }, ErrInvalidLease},
		{"bad attempt", func(i *ResultInput) { i.Attempt = 33 }, ErrInvalidLease},
		{"chunk without generation", func(i *ResultInput) { i.ChunkID = testID(t) }, ErrInvalidArtifact},
		{"chunk with generation", func(i *ResultInput) { i.ChunkID = testID(t); i.Generation = 1 }, nil},
		{"short sha", func(i *ResultInput) { i.ResultSHA256 = make([]byte, 31) }, ErrInvalidArtifact},
		{"zero size", func(i *ResultInput) { i.ResultSize = 0 }, ErrInvalidArtifact},
		{"max size", func(i *ResultInput) { i.ResultSize = 524288000 }, nil},
		{"over size", func(i *ResultInput) { i.ResultSize = 524288001 }, ErrInvalidArtifact},
		{"content type", func(i *ResultInput) { i.ResultContentType = "text/plain" }, ErrInvalidArtifact},
		{"empty provider", func(i *ResultInput) { i.Provider = "" }, ErrInvalidArtifact},
		{"long provider", func(i *ResultInput) { i.Provider = strings.Repeat("a", 129) }, ErrInvalidArtifact},
		{"max provider", func(i *ResultInput) { i.Provider = strings.Repeat("a", 128) }, nil},
		{"empty model", func(i *ResultInput) { i.Model = "" }, ErrInvalidArtifact},
		{"long model", func(i *ResultInput) { i.Model = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"empty version", func(i *ResultInput) { i.ProviderVersion = "" }, ErrInvalidArtifact},
		{"long version", func(i *ResultInput) { i.ProviderVersion = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"negative billed", func(i *ResultInput) { i.BilledAudioSeconds = -1 }, ErrInvalidArtifact},
		{"over billed", func(i *ResultInput) { i.BilledAudioSeconds = 86401 }, ErrInvalidArtifact},
		{"max billed", func(i *ResultInput) { i.BilledAudioSeconds = 86400 }, nil},
		{"negative provider duration", func(i *ResultInput) { i.ProviderDurationSeconds = &neg }, ErrInvalidArtifact},
		{"over provider duration", func(i *ResultInput) { i.ProviderDurationSeconds = &big }, ErrInvalidArtifact},
		{"max provider duration", func(i *ResultInput) { i.ProviderDurationSeconds = &okInt }, nil},
		{"negative measured", func(i *ResultInput) { i.MeasuredAudioMS = -1 }, ErrInvalidArtifact},
		{"over measured", func(i *ResultInput) { i.MeasuredAudioMS = 86400001 }, ErrInvalidArtifact},
		{"max measured", func(i *ResultInput) { i.MeasuredAudioMS = 86400000 }, nil},
		{"negative observed", func(i *ResultInput) { i.ProviderObservedDurationMS = &negMS }, ErrInvalidArtifact},
		{"over observed", func(i *ResultInput) { i.ProviderObservedDurationMS = &bigMS }, ErrInvalidArtifact},
		{"max observed", func(i *ResultInput) { i.ProviderObservedDurationMS = &okMS }, nil},
		{"long execution identity", func(i *ResultInput) { i.ExecutionIdentity = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"max execution identity", func(i *ResultInput) { i.ExecutionIdentity = strings.Repeat("a", 256) }, nil},
		{"long provider request id", func(i *ResultInput) { i.ProviderRequestID = strings.Repeat("a", 257) }, ErrInvalidArtifact},
		{"invalid quality", func(i *ResultInput) { i.Quality = json.RawMessage(`{`) }, ErrInvalidArtifact},
		{"valid quality", func(i *ResultInput) { i.Quality = json.RawMessage(`{"a":1}`) }, nil},
		{"oversize quality", func(i *ResultInput) {
			i.Quality = json.RawMessage(`"` + strings.Repeat("a", 16384) + `"`)
		}, ErrInvalidArtifact},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := validResultInput(t)
			tc.mutate(&input)
			err := prepareResultInput(&input)
			if !errors.Is(err, tc.want) || (tc.want == nil) != (err == nil) {
				t.Fatalf("error = %v, want %v", err, tc.want)
			}
		})
	}

	input := validResultInput(t)
	if err := prepareResultInput(&input); err != nil || string(input.Quality) != `{}` {
		t.Fatalf("quality default = %q, err %v", input.Quality, err)
	}
}
