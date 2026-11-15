package postgres

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/q9labs/chalk/apps/api/internal/config"
)

// A database that is away at start is waited for, not given up on: Open must outlast the first failed ping
// and return only when its context ends.
func TestOpenWaitsForAnUnreachableDatabase(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	t.Cleanup(cancel)
	started := time.Now()
	pool, err := Open(ctx, config.DatabaseConfig{URL: "postgres://chalk:chalk@" + address + "/chalk?sslmode=disable", MaxConns: 2})
	if pool != nil {
		pool.Close()
		t.Fatal("Open returned a pool for an unreachable database")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("Open ended with %v, want the context deadline", err)
	}
	if elapsed := time.Since(started); elapsed < time.Second {
		t.Fatalf("Open gave up after %v instead of waiting for the database", elapsed)
	}
}

func TestOpenRejectsABadConfigurationAtOnce(t *testing.T) {
	started := time.Now()
	if _, err := Open(context.Background(), config.DatabaseConfig{URL: "postgres://chalk@127.0.0.1/chalk", MaxConns: 0}); err == nil {
		t.Fatal("Open accepted zero connections")
	}
	if time.Since(started) > time.Second {
		t.Fatal("Open retried a configuration error")
	}
}
