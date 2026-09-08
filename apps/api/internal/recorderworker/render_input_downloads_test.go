package recorderworker

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/recordingrender"
)

type renderDownloadControl struct {
	RenderAuthorityPort
	input      recordingrender.ResolvedInput
	resolved   int
	downloaded []string
	authority  recordingrender.Authority
}

func (control *renderDownloadControl) ResolveRenderInput(_ context.Context, authority recordingrender.Authority) (recordingrender.ResolvedInput, error) {
	control.resolved++
	control.authority = authority
	return control.input, nil
}

func (control *renderDownloadControl) DownloadRenderObject(_ context.Context, object recordingrender.DownloadableObject, _ string) error {
	control.downloaded = append(control.downloaded, object.Download.URL)
	return nil
}

func TestRenderDownloadsRefreshExpiredBatchUnderRenewedAuthority(t *testing.T) {
	now := time.Date(2026, time.September, 7, 20, 0, 0, 0, time.UTC)
	object := recordingrender.DownloadableObject{
		ObjectFacts: recordingrender.ObjectFacts{ObjectKey: "presentation", ObjectVersion: "v1", SHA256: []byte("original")},
		Download:    recordingrender.DownloadGrant{URL: "first", ExpiresAt: now.Add(10 * time.Minute)},
	}
	input := recordingrender.ResolvedInput{Presentation: object}
	control := &renderDownloadControl{input: input}
	attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{Control: control, Now: func() time.Time { return now }}}
	downloads, err := newRenderInputDownloader(attempt, input)
	if err != nil {
		t.Fatal(err)
	}
	if err := downloads.download(context.Background(), object, "first"); err != nil {
		t.Fatal(err)
	}
	if control.resolved != 0 {
		t.Fatal("unexpired batch was re-signed")
	}
	now = now.Add(11 * time.Minute)
	attempt.authority.LeaseExpiresAt = now.Add(30 * time.Minute)
	control.input.Presentation.Download = recordingrender.DownloadGrant{URL: "renewed", ExpiresAt: now.Add(10 * time.Minute)}
	for range 2 {
		if err := downloads.download(context.Background(), object, "later"); err != nil {
			t.Fatal(err)
		}
	}
	if control.resolved != 1 || !control.authority.LeaseExpiresAt.Equal(attempt.authority.LeaseExpiresAt) {
		t.Fatalf("refreshes = %d, lease = %s", control.resolved, control.authority.LeaseExpiresAt)
	}
	if len(control.downloaded) != 3 || control.downloaded[0] != "first" || control.downloaded[1] != "renewed" || control.downloaded[2] != "renewed" {
		t.Fatalf("download grants = %v", control.downloaded)
	}
	control.input.Presentation.ObjectVersion = "changed"
	now = now.Add(11 * time.Minute)
	control.input.Presentation.Download.ExpiresAt = now.Add(10 * time.Minute)
	if err := downloads.download(context.Background(), object, "changed"); !errors.Is(err, ErrInvalidProductionRenderAttempt) {
		t.Fatalf("changed immutable object error = %v", err)
	}
	if len(control.downloaded) != 3 {
		t.Fatal("downloaded changed recording input")
	}
}

func TestRenderClaimRejectsMissingOrExpiredHardDeadline(t *testing.T) {
	now := time.Date(2026, time.September, 7, 20, 0, 0, 0, time.UTC)
	for _, deadline := range []string{"", "invalid", now.Format(time.RFC3339Nano), now.Add(-time.Second).Format(time.RFC3339Nano)} {
		claim := productionRenderClaimForTest(t, now)
		claim.Envelope.HardDeadline = deadline
		if _, err := renderAuthorityFromClaim(claim, now); !errors.Is(err, ErrInvalidProductionRenderAttempt) {
			t.Fatalf("deadline %q error = %v", deadline, err)
		}
	}
}

func TestRenderCaptureDownloadsUseCommittedReservationSequence(t *testing.T) {
	for _, sequences := range [][]int64{{0, 2}, {0, 0}, {-1, 0}} {
		t.Run(fmt.Sprint(sequences), func(t *testing.T) {
			now := time.Now()
			input := recordingrender.ResolvedInput{}
			for index, sequence := range sequences {
				input.Capture = append(input.Capture, recordingrender.DownloadableCaptureObject{
					CaptureObject: recordingrender.CaptureObject{
						ObjectFacts:    recordingrender.ObjectFacts{ObjectKey: fmt.Sprint("bundle-", index), ByteSize: 10},
						SequenceNumber: sequence,
					},
					Download: recordingrender.DownloadGrant{URL: fmt.Sprint("grant-", index), ExpiresAt: now.Add(time.Hour)},
				})
			}
			control := &renderDownloadControl{input: input}
			attempt := &ProductionRenderAttempt{config: ProductionRenderAttemptConfig{Control: control, Now: func() time.Time { return now }}}
			downloads, err := newRenderInputDownloader(attempt, input)
			if err != nil {
				t.Fatal(err)
			}
			bundles, bytes, err := attempt.downloadCapture(context.Background(), downloads, input, t.TempDir())
			if sequences[0] != 0 || sequences[1] != 2 {
				if !errors.Is(err, ErrInvalidProductionRenderAttempt) {
					t.Fatalf("invalid sequence accepted: %v", err)
				}
				return
			}
			if err != nil || bytes != 20 || len(bundles) != 2 || bundles[0].Sequence != 0 || bundles[1].Sequence != 2 {
				t.Fatalf("committed zero-based sequence: bundles=%v bytes=%d err=%v", bundles, bytes, err)
			}
		})
	}
}
