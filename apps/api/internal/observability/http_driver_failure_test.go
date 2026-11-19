package observability

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

// The hostile text stands for what a driver echoes: a host, an address, a
// connection string and a credential. None of it may reach a log line.
const (
	hostileHost = "db-primary.internal.example"
	hostileAddr = "10.20.30.40:5432"
	hostileDSN  = "postgres://chalk_app:hunter2@db-primary.internal.example:5432/chalk"
)

func TestHTTPFailureLogExportsFactsNotDriverText(t *testing.T) {
	hostileText := fmt.Sprintf("could not connect to %s (%s) using %s", hostileHost, hostileAddr, hostileDSN)
	for name, test := range map[string]struct {
		err   error
		attrs map[string]any
	}{
		"postgres error": {
			err:   &pgconn.PgError{Code: "08006", Message: hostileText},
			attrs: map[string]any{"error_class": "postgres", "sqlstate": "08006", "connect": false, "timeout": false},
		},
		"postgres error with an unsafe code": {
			err:   &pgconn.PgError{Code: hostileDSN, Message: hostileText},
			attrs: map[string]any{"error_class": "postgres", "connect": false, "timeout": false},
		},
		"wrapped postgres error": {
			err:   fmt.Errorf("transcription artifact repository unavailable: %w", fmt.Errorf("begin: %w", &pgconn.PgError{Code: "57P01", Message: hostileText})),
			attrs: map[string]any{"error_class": "postgres", "sqlstate": "57P01", "connect": false, "timeout": false},
		},
		"network error": {
			err: fmt.Errorf("claim: %w", &net.OpError{Op: "dial", Net: "tcp", Addr: &net.TCPAddr{IP: net.ParseIP("10.20.30.40"), Port: 5432},
				Err: errors.New("connection refused: " + hostileText)}),
			attrs: map[string]any{"error_class": "network", "connect": false, "timeout": false},
		},
		"timeout": {
			err:   &net.DNSError{Err: "i/o timeout " + hostileText, Name: hostileHost, Server: hostileAddr, IsTimeout: true},
			attrs: map[string]any{"error_class": "network", "connect": false, "timeout": true},
		},
		"unparsable connection string": {
			err:   &pgconn.ParseConfigError{ConnString: hostileDSN},
			attrs: map[string]any{"error_class": "postgres_config", "connect": false, "timeout": false},
		},
	} {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			ctx := context.WithValue(context.Background(), requestLoggerContextKey{}, slog.New(slog.NewJSONHandler(&out, nil)))
			LogHTTPError(ctx, http.MethodPost, "/internal/v1/transcription/jobs/claim", "service.unavailable", test.err)

			for _, leaked := range []string{hostileHost, "10.20.30.40", "5432", "hunter2", "chalk_app", "postgres://"} {
				if strings.Contains(out.String(), leaked) {
					t.Fatalf("log contains %q: %s", leaked, out.String())
				}
			}
			line := decodeLogLines(t, &out)[0]
			if line["error"] != driverFailureDetail || line["code"] != "service.unavailable" || line["route"] != "/internal/v1/transcription/jobs/claim" {
				t.Fatalf("log = %v", line)
			}
			for key, want := range test.attrs {
				if line[key] != want {
					t.Fatalf("%s = %v, want %v in %v", key, line[key], want, line)
				}
			}
			if _, ok := line["sqlstate"]; ok && test.attrs["sqlstate"] == nil {
				t.Fatalf("unsafe SQLSTATE reached the log: %v", line)
			}
		})
	}
}
