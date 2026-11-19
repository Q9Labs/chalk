package postgres

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

type failingTranscriptTransactor struct{ err error }

func (t failingTranscriptTransactor) Begin(context.Context) (pgx.Tx, error) { return nil, t.err }

func TestTranscriptClaimsReportAnUnreachableDatabaseAsRepositoryUnavailable(t *testing.T) {
	noPrimary := &pgconn.PgError{Code: "08006", Message: "no primary"}
	for name, test := range map[string]struct {
		cause       error
		unavailable bool
	}{
		"connection failure SQLSTATE": {cause: noPrimary, unavailable: true},
		"wrapped connect error":       {cause: errors.Join(errors.New("failed to connect"), noPrimary), unavailable: true},
		"network timeout":             {cause: &net.OpError{Op: "dial", Err: context.DeadlineExceeded}, unavailable: true},
		"other database error":        {cause: &pgconn.PgError{Code: "23505"}},
		"plain error":                 {cause: errors.New("boom")},
	} {
		t.Run(name, func(t *testing.T) {
			repository := NewTranscriptRepositoryWithPool(nil, failingTranscriptTransactor{err: test.cause})
			now := time.Now()
			_, claimErr := repository.Claim(context.Background(), transcripts.ClaimInput{Now: now})
			_, finalizerErr := repository.ClaimFinalizer(context.Background(), transcripts.FinalizerClaimInput{Now: now})
			_, _, cleanupErr := repository.ClaimCleanup(context.Background(), transcripts.CleanupClaimInput{Now: now})
			for operation, err := range map[string]error{"claim": claimErr, "finalizer": finalizerErr, "cleanup": cleanupErr} {
				if errors.Is(err, transcripts.ErrArtifactRepository) != test.unavailable {
					t.Fatalf("%s error = %v, unavailable = %t", operation, err, test.unavailable)
				}
				if !errors.Is(err, test.cause) {
					t.Fatalf("%s error lost its cause: %v", operation, err)
				}
			}
		})
	}
}
