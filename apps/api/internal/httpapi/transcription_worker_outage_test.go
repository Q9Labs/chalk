package httpapi

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/q9labs/chalk/apps/api/internal/adapters/postgres"
	"github.com/q9labs/chalk/apps/api/internal/transcripts"
)

// On 2026-11-15, 01:10 to 04:29 UTC, the production Postgres branch had no
// primary and every claim failed with SQLSTATE 08006. The API logged nothing, so
// the exact error chain pgx produced is not recorded. These tests keep what is
// known: the code (08006) and that pgx got it from the server. They drive the
// real pgx pool against a server that speaks the wire protocol and answers each
// way the outage could have reached the adapter, so the error is the one pgx
// builds, not one written by hand:
//   - FATAL 08006 in reply to the startup message (connect-time, wrapped by pgx in a ConnectError);
//   - FATAL 08006 in reply to the first statement of an established connection;
//   - the connection dropped after startup;
//   - a server that never answers, so the connect attempt times out;
//   - nothing listening, so the pool cannot acquire a connection.
//
// The message text is sanitized: the real wording is not in any retained log.
type outageServer func(connection net.Conn)

func serveOutage(t *testing.T, behave outageServer) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	if behave == nil {
		address := listener.Addr().String()
		_ = listener.Close()
		return address
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer connection.Close()
				behave(connection)
			}()
		}
	}()
	return listener.Addr().String()
}

func readFrontendMessage(connection net.Conn, startup bool) error {
	header := make([]byte, 4)
	if !startup {
		header = make([]byte, 5)
	}
	if _, err := io.ReadFull(connection, header); err != nil {
		return err
	}
	length := int(binary.BigEndian.Uint32(header[len(header)-4:]))
	_, err := io.CopyN(io.Discard, connection, int64(length-4))
	return err
}

func backendMessage(kind byte, body ...byte) []byte {
	message := []byte{kind, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(message[1:], uint32(len(body)+4))
	return append(message, body...)
}

func errorResponse(severity, code, message string) []byte {
	var body []byte
	for _, field := range [][2]string{{"S", severity}, {"V", severity}, {"C", code}, {"M", message}} {
		body = append(append(body, field[0][0]), append([]byte(field[1]), 0)...)
	}
	return backendMessage('E', append(body, 0)...)
}

func acceptStartup(connection net.Conn) bool {
	if readFrontendMessage(connection, true) != nil {
		return false
	}
	ready := append(backendMessage('R', 0, 0, 0, 0), backendMessage('K', 0, 0, 0, 1, 0, 0, 0, 2)...)
	_, err := connection.Write(append(ready, backendMessage('Z', 'I')...))
	return err == nil
}

func TestTranscriptionClaimsAnswer503ForTheNoPrimaryOutage(t *testing.T) {
	const noPrimary = "no primary available"
	for name, test := range map[string]struct {
		behave     outageServer
		sqlstate   string
		errorClass string
	}{
		"FATAL 08006 at connect": {
			behave: func(c net.Conn) {
				_ = readFrontendMessage(c, true)
				_, _ = c.Write(errorResponse("FATAL", "08006", noPrimary))
			},
			sqlstate:   "08006",
			errorClass: "postgres",
		},
		"FATAL 08006 on the first statement": {
			behave: func(c net.Conn) {
				if acceptStartup(c) && readFrontendMessage(c, false) == nil {
					_, _ = c.Write(errorResponse("FATAL", "08006", noPrimary))
				}
			},
			sqlstate:   "08006",
			errorClass: "postgres",
		},
		"connection dropped after startup": {
			behave: func(c net.Conn) {
				if acceptStartup(c) {
					_ = readFrontendMessage(c, false)
				}
			},
			errorClass: "",
		},
		"server never answers": {
			behave:     func(c net.Conn) { _ = readFrontendMessage(c, true); _, _ = io.Copy(io.Discard, c) },
			errorClass: "postgres_connect",
		},
		"password refused at connect": {
			behave: func(c net.Conn) {
				_ = readFrontendMessage(c, true)
				_, _ = c.Write(errorResponse("FATAL", "28P01", "password authentication failed"))
			},
			sqlstate:   "28P01",
			errorClass: "postgres",
		},
		"nothing listening": {behave: nil, errorClass: "postgres_connect"},
	} {
		for _, path := range transcriptionClaimRoutes {
			t.Run(name+" "+path, func(t *testing.T) {
				address := serveOutage(t, test.behave)
				pool, err := pgxpool.New(context.Background(), "postgres://chalk_app:hunter2@"+address+"/chalk?sslmode=disable&connect_timeout=1")
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(pool.Close)
				service := transcripts.NewService(postgres.NewTranscriptRepositoryWithPool(nil, pool))

				response, journeyID, lines := serveTranscriptionWorker(t, service, workloadAuthorizerFunc(allowWorkload), path, nil)
				if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"service.unavailable"`) {
					t.Fatalf("response = %d %s; log = %v", response.Code, response.Body.String(), logLine(lines, "http.failure"))
				}
				line := logLine(lines, "http.failure")
				if line == nil || line["code"] != "service.unavailable" || line["journey_id"] != journeyID {
					t.Fatalf("failure log = %v", line)
				}
				if test.sqlstate != "" && line["sqlstate"] != test.sqlstate {
					t.Fatalf("sqlstate = %v, want %s in %v", line["sqlstate"], test.sqlstate, line)
				}
				if test.errorClass != "" && line["error_class"] != test.errorClass {
					t.Fatalf("error_class = %v, want %s in %v", line["error_class"], test.errorClass, line)
				}
				encoded, err := json.Marshal(lines)
				if err != nil {
					t.Fatal(err)
				}
				host, port, _ := net.SplitHostPort(address)
				for _, private := range []string{host, port, "hunter2", "chalk_app", "postgres://", noPrimary, "password authentication failed"} {
					if bytes.Contains(encoded, []byte(private)) {
						t.Fatalf("log contains %q: %s", private, encoded)
					}
				}
			})
		}
	}
}
