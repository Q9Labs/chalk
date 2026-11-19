package postgres

import (
	"errors"
	"fmt"
	"net"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

// artifactRepositoryFailure reports a database that cannot be reached as
// ErrArtifactRepository, so the HTTP boundary answers 503 instead of an
// unexplained 500. That covers a failed connection attempt (pgx wraps what the
// server or the socket said in *pgconn.ConnectError), a server-side connection
// failure such as a branch with no primary (SQLSTATE class 08), a network
// error and a statement on a connection that is already closed. The cause stays in the chain for the log. Every other error passes
// through unchanged.
func artifactRepositoryFailure(err error) error {
	var pgError *pgconn.PgError
	var connectError *pgconn.ConnectError
	var network net.Error
	switch {
	case err == nil, errors.Is(err, transcripts.ErrArtifactRepository):
		return err
	case errors.As(err, &connectError), errors.As(err, &network), pgconn.SafeToRetry(err), errors.As(err, &pgError) && strings.HasPrefix(pgError.Code, "08"):
		return fmt.Errorf("%w: %w", transcripts.ErrArtifactRepository, err)
	}
	return err
}
